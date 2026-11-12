import type { DaemonNodeEvent, DaemonNodeRunCommand } from 'relay-core';
import type { DaemonLogger } from './index.js';
import { AdmissionLedger } from './admission-ledger.js';
import { ExecutionJournal } from './execution-journal.js';
import { ExecutionWatchdog } from './execution-watchdog.js';
import { WorkspaceRunGate } from './workspace-run-gate.js';
import { admissionWaitReason, type RuntimeLimits } from './run-admission.js';
import { watchExecutionExit } from './execution-capture.js';
import { hostBootAt } from './exit-proof.js';
import { transportErrorDetail } from './http-error-detail.js';

interface SupervisorOptions {
  journal: ExecutionJournal;
  ledger: AdmissionLedger;
  watchdog: ExecutionWatchdog;
  workspaceGate: WorkspaceRunGate;
  maxConcurrentRuns: number;
  runtimeLimits: RuntimeLimits;
  leaseDurationMs: number;
  sandboxId: string;
  logger: DaemonLogger;
  report(event: DaemonNodeEvent, command: DaemonNodeRunCommand, signal: AbortSignal): Promise<void>;
  exitUnconfirmed(command: DaemonNodeRunCommand): Promise<void>;
  onIdle(): void;
}
interface Run {
  command: DaemonNodeRunCommand;
  controller: AbortController;
  release: AbortController;
  terminal: boolean;
  promise: Promise<void>;
}
export type RunAdmission = 'accepted' | 'duplicate' | 'recovery-required' | 'computer-capacity' | 'runtime-capacity' | 'draining';

/** Owns live execution identity through durable terminal handoff, independent of upload. */
export class RunSupervisor {
  private readonly runs = new Map<string, Run>();
  private closed = false;
  constructor(private readonly options: SupervisorOptions) {}
  get size(): number { return this.runs.size; }
  has(id: string): boolean { return this.runs.has(id); }
  isTerminal(id: string): boolean { return this.runs.get(id)?.terminal ?? false; }
  commands(executingOnly = false): DaemonNodeRunCommand[] {
    return [...this.runs.values()].filter(run => !executingOnly || !run.terminal).map(run => run.command);
  }
  terminalStored(id: string): void {
    const run = this.runs.get(id);
    if (run) run.terminal = true;
    this.options.watchdog.forget(id);
  }
  reconcile(id: string): void { this.runs.get(id)?.release.abort('Reported gone by an operator.'); }
  cancel(id: string, reason?: string): void { this.runs.get(id)?.controller.abort(reason); }
  stopAll(reason: string, includeReports = true): void {
    for (const run of this.runs.values()) if (includeReports || !run.terminal) run.controller.abort(reason);
  }
  closeAdmission(): void { this.closed = true; }
  async settle(): Promise<void> { await Promise.allSettled([...this.runs.values()].map(run => run.promise)); }

  accept(
    command: DaemonNodeRunCommand,
    workspace: string | undefined,
    execute: (signal: AbortSignal) => Promise<DaemonNodeEvent>,
    onWaiting?: (blockingSessionId: string | null | undefined, signal: AbortSignal) => Promise<void>,
    preparation?: Promise<void>,
  ): RunAdmission {
    if (this.closed) return 'draining';
    const active = this.runs.get(command.id);
    if (active) {
      // Preserve the existing duplicate-dispatch lease refresh contract.
      if (command.leaseId) active.command.leaseId = command.leaseId;
      if (command.leaseExpiresAt) active.command.leaseExpiresAt = command.leaseExpiresAt;
      if (command.attempt !== undefined) active.command.attempt = command.attempt;
      return 'duplicate';
    }
    if (this.options.ledger.has(command.id) || this.options.journal.has(command.id)) return 'recovery-required';
    const wait = admissionWaitReason(this.commands(true), command.agent, this.options.maxConcurrentRuns, this.options.runtimeLimits);
    if (wait) return wait;
    this.options.journal.record(command);
    this.options.ledger.add(command.id);
    const controller = new AbortController();
    const release = new AbortController();
    const run: Run = { command, controller, release, terminal: false, promise: Promise.resolve() };
    this.runs.set(command.id, run);
    if (command.leaseId) this.options.watchdog.track(command.id, this.options.leaseDurationMs,
      () => controller.abort('Execution lease expired; stopping until ownership can be confirmed.'));
    watchExecutionExit(controller.signal, {
      release: release.signal, stopGraceMs: 10_000,
      onSpawn: (processGroup, spawnedAt) => {
        try { this.options.journal.attach(command.id, { processGroup, spawnedAt, bootAt: hostBootAt() }); }
        catch (error) { this.options.logger.warn('could not record the run\'s process group', this.fields(command, error)); }
      },
      onExitUnconfirmed: () => {
        this.options.logger.warn('Stopped run\'s exit cannot be verified; keeping the run reserved', this.fields(command));
        void this.options.exitUnconfirmed(command).catch(error => {
          this.options.logger.warn('exit-unconfirmed report failed', this.fields(command, error));
        });
      },
    });
    run.promise = this.execute(run, workspace, execute, onWaiting, preparation);
    return 'accepted';
  }

  private async execute(
    run: Run, workspace: string | undefined,
    execute: (signal: AbortSignal) => Promise<DaemonNodeEvent>,
    onWaiting?: (blockingSessionId: string | null | undefined, signal: AbortSignal) => Promise<void>,
    preparation?: Promise<void>,
  ): Promise<void> {
    const { command, controller } = run;
    try {
      // Yield so admission is fully installed before an execution can complete.
      await Promise.resolve();
      if (preparation) await waitForPreparation(preparation, controller.signal);
      const event = await this.options.workspaceGate.run(workspace, controller.signal,
        () => { controller.signal.throwIfAborted(); return execute(controller.signal); },
        onWaiting ? { sessionId: command.sessionId, onWaiting: id => onWaiting(id, controller.signal) } : undefined);
      await this.options.report(event, command, controller.signal);
    } catch (error) {
      if (run.terminal) {
        this.options.logger.warn('terminal delivery deferred; original exit evidence preserved', this.fields(command, error));
        return;
      }
      const base = { commandId: command.id, ...(command.leaseId ? { leaseId: command.leaseId } : {}),
        sessionId: command.sessionId, runId: command.runId, agent: command.agent };
      const event: DaemonNodeEvent = controller.signal.aborted
        ? { ...base, type: 'run.cancelled', reason: typeof controller.signal.reason === 'string' ? controller.signal.reason : 'Daemon run cancelled.' }
        : { ...base, type: 'run.failed', error: transportErrorDetail(error) };
      this.options.logger.error('command failed before completion', this.fields(command, error));
      try { await this.options.report(event, command, controller.signal); }
      catch (postError) { this.options.logger.error('terminal event post failed', this.fields(command, postError)); }
    } finally {
      this.runs.delete(command.id);
      this.options.watchdog.forget(command.id);
      this.options.onIdle();
    }
  }
  private fields(command: DaemonNodeRunCommand, error?: unknown) {
    return { sandboxId: this.options.sandboxId, commandId: command.id, sessionId: command.sessionId,
      runId: command.runId, agent: command.agent, ...(error === undefined ? {} : { error: transportErrorDetail(error) }) };
  }
}

async function waitForPreparation(preparation: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('Run cancelled while waiting for runtime refresh.'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { await Promise.race([preparation, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
