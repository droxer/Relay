import type {
  ManagedNodeBackend,
  ManagedNodeProvider,
  ManagedNodeRecord,
  ProviderInstance,
  ProvisioningAttemptRecord,
  SupervisorLogger,
} from "./types.js";

export interface ManagedNodeReconcilerOptions {
  backend: ManagedNodeBackend;
  providers: ManagedNodeProvider[];
  backendUrl: string;
  workspacePathForNode: (node: ManagedNodeRecord) => string;
  recoveryGraceMs?: number;
  registrationTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Max time a managed node can sit in "deleting" phase before the
   *  reconciler forces cleanup without waiting for runs to drain. */
  deletionDeadlineMs?: number;
  now?: () => number;
  logger?: SupervisorLogger;
}

export interface ManagedReconcileResult {
  nodes: number;
  started: number;
  skipped: number;
  /** Online managed computers that already satisfy the desired running state. */
  healthy: number;
  failed: number;
}

export function workspaceIdForManagedNode(node: ManagedNodeRecord): string {
  const configured = node.workspacePolicy.workspaceId;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return `managed-node:${node.id}:workspace-root`;
}

const DEFAULT_RETRY_BASE_MS = 10_000;
const DEFAULT_RETRY_MAX_MS = 3_600_000;

/** Capped exponential backoff, so a permanently failing node stops hot-looping. */
export function provisioningRetryDelayMs(
  attemptNumber: number,
  baseMs = DEFAULT_RETRY_BASE_MS,
  maxMs = DEFAULT_RETRY_MAX_MS,
): number {
  const exponent = Math.min(Math.max(attemptNumber, 1) - 1, 20);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * The latest retry deadline recorded for the node's current generation.
 * Changing provider config bumps the generation, which resets the backoff so an
 * admin fixing a misconfiguration is not left waiting out the previous delay.
 */
function provisioningRetryAt(
  attempts: ProvisioningAttemptRecord[],
  generation: number,
): number | undefined {
  let latest: number | undefined;
  for (const attempt of attempts) {
    if (attempt.generation !== generation || !attempt.retryAt) continue;
    const deadline = Date.parse(attempt.retryAt);
    if (Number.isNaN(deadline)) continue;
    if (latest === undefined || deadline > latest) latest = deadline;
  }
  return latest;
}

const DEFAULT_DELETION_DEADLINE_MS = 10 * 60_000;

export class ManagedNodeReconciler {
  private readonly backend: ManagedNodeBackend;
  private readonly providers: Map<string, ManagedNodeProvider>;
  private readonly backendUrl: string;
  private readonly workspacePathForNode: (node: ManagedNodeRecord) => string;
  private readonly recoveryGraceMs: number;
  private readonly registrationTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly deletionDeadlineMs: number;
  private readonly now: () => number;
  private readonly logger?: SupervisorLogger;
  private readonly instances = new Map<string, {
    provider: ManagedNodeProvider;
    instance: ProviderInstance;
    generation: number;
  }>();

  constructor(options: ManagedNodeReconcilerOptions) {
    this.backend = options.backend;
    this.providers = new Map(options.providers.map((provider) => [provider.name, provider]));
    this.backendUrl = options.backendUrl;
    this.workspacePathForNode = options.workspacePathForNode;
    this.recoveryGraceMs = options.recoveryGraceMs ?? 60_000;
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? 15 * 60_000;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.deletionDeadlineMs = options.deletionDeadlineMs ?? DEFAULT_DELETION_DEADLINE_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  async reconcileOnce(): Promise<ManagedReconcileResult> {
    const nodes = await this.backend.listManagedNodes();
    const daemonNodes = await this.backend.listDaemonNodes();
    const daemonById = new Map(daemonNodes.map((node) => [node.id, node]));
    let started = 0;
    let skipped = 0;
    let healthy = 0;
    let failed = 0;
    for (const node of nodes) {
      try {
      const provider = this.providers.get(node.provider);
      let runtimeRetired = false;
      if (!provider) {
        const message = `Managed node provider ${node.provider} is unavailable.`;
        const currentCondition = node.conditions.find((condition) =>
          condition.type === "ProviderAvailable"
          && condition.reason === "ProviderUnavailable"
          && condition.observedGeneration === node.generation
          && condition.message === message
        );
        if (node.phase !== "failed" || !currentCondition) {
          await this.backend.updateManagedNode(node.id, {
            phase: "failed",
            conditions: [
              ...node.conditions.filter((condition) =>
                condition.type !== "ProviderAvailable"
                || condition.observedGeneration !== node.generation
              ),
              {
                type: "ProviderAvailable",
                status: "False",
                reason: "ProviderUnavailable",
                message,
                observedGeneration: node.generation,
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }
        this.logger?.error("managed node provider unavailable", { nodeId: node.id, provider: node.provider });
        failed += 1;
        continue;
      }
      if (node.desiredState !== "running") {
        const terminalPhase = node.desiredState === "deleted" ? "deleted" : "stopped";
        if (node.phase === terminalPhase) {
          skipped += 1;
          continue;
        }
        const deletionAgeMs = this.now() - Date.parse(node.updatedAt);
        const forceDelete = node.desiredState === "deleted" && deletionAgeMs > this.deletionDeadlineMs;
        if (node.activeDaemonNodeId && !forceDelete) {
          if (!await this.retireRuntimeWhenDrained(node)) {
            skipped += 1;
            continue;
          }
        }
        if (forceDelete) {
          this.logger?.warn("managed node deletion deadline exceeded, forcing cleanup", {
            nodeId: node.id,
            deletionAgeMs,
            deadlineMs: this.deletionDeadlineMs,
          });
        }
        const attempts = await this.backend.listProvisioningAttempts(node.id);
        const instanceId = [...attempts].reverse().find((attempt) => attempt.providerInstanceId)?.providerInstanceId;
        if (instanceId) {
          if (node.desiredState === "deleted") await provider.delete(instanceId);
          else await provider.stop(instanceId);
          if (await provider.inspect(instanceId) === "running") {
            skipped += 1;
            continue;
          }
        }
        this.instances.delete(node.id);
        await this.backend.updateManagedNode(node.id, { phase: terminalPhase });
        skipped += 1;
        continue;
      }
      const attempts = await this.backend.listProvisioningAttempts(node.id);
      const daemon = node.activeDaemonNodeId ? daemonById.get(node.activeDaemonNodeId) : undefined;
      const runtimeAttempt = attempts.find((attempt) => attempt.id === daemon?.provisioningAttemptId)
        ?? attempts.find((attempt) => attempt.id === node.activeAttemptId)
        ?? [...attempts].reverse().find((attempt) => attempt.providerInstanceId);
      const currentGeneration = runtimeAttempt?.generation === node.generation;
      if (["allocating", "bootstrapping", "registering"].includes(node.phase)
        && currentGeneration && runtimeAttempt
        && !["failed", "cancelled"].includes(runtimeAttempt.status)
        && (node.activeAttemptId || node.activeDaemonNodeId || this.instances.has(node.id))
        && this.now() - Date.parse(runtimeAttempt.startedAt) > this.registrationTimeoutMs) {
        if (node.activeDaemonNodeId && !await this.retireRuntimeWhenDrained(node)) {
          skipped += 1;
          continue;
        }
        const instanceId = runtimeAttempt.providerInstanceId ?? this.instances.get(node.id)?.instance.id;
        if (instanceId) await provider.stop(instanceId);
        this.instances.delete(node.id);
        if (!["succeeded", "failed", "cancelled"].includes(runtimeAttempt.status)) {
          await this.backend.updateProvisioningAttempt(node.id, runtimeAttempt.id, {
            status: "failed", errorCode: "registration_timeout",
            errorMessage: "Daemon did not become ready over HTTP before the registration deadline.",
            retryAt: new Date(this.now() + provisioningRetryDelayMs(runtimeAttempt.attemptNumber,
              this.retryBaseMs, this.retryMaxMs)).toISOString(),
          });
        } else {
          await this.backend.updateManagedNode(node.id, { phase: "requested" });
        }
        failed += 1;
        continue;
      }
      if (node.phase === "ready") {
        if (currentGeneration && daemon?.online && !daemon.stale && (daemon.status === "ready" || daemon.status === "busy" || daemon.status === "running")) {
          skipped += 1;
          healthy += 1;
          continue;
        }
        const instanceId = runtimeAttempt?.providerInstanceId;
        const instanceRunning = Boolean(
          instanceId && await provider.inspect(instanceId) === "running"
        );
        if (instanceRunning && currentGeneration) {
          const lastSeenAgeMs = daemon?.lastSeenAgeMs;
          if (typeof lastSeenAgeMs === "number" && lastSeenAgeMs <= this.recoveryGraceMs) {
            this.logger?.warn("managed node heartbeat is recovering", {
              nodeId: node.id,
              daemonNodeId: node.activeDaemonNodeId,
              lastSeenAgeMs,
            });
            skipped += 1;
            continue;
          }
        }
        if (node.activeDaemonNodeId) {
          if (!await this.retireRuntimeWhenDrained(node)) {
            skipped += 1;
            continue;
          }
          runtimeRetired = true;
        }
        if (instanceId && instanceRunning) await provider.stop(instanceId);
        this.instances.delete(node.id);
        await this.backend.updateManagedNode(node.id, { phase: "requested" });
      }
      if (node.phase !== "ready" && node.activeDaemonNodeId && !runtimeRetired) {
        const daemon = daemonById.get(node.activeDaemonNodeId);
        const linkedAttempt = attempts.find((attempt) => attempt.id === daemon?.provisioningAttemptId)
          ?? attempts.find((attempt) => attempt.id === node.activeAttemptId)
          ?? [...attempts].reverse().find((attempt) => attempt.providerInstanceId);
        const linkedInstanceId = linkedAttempt?.providerInstanceId;
        const currentRuntimeRunning = Boolean(
          linkedAttempt?.generation === node.generation
          && linkedInstanceId
          && await provider.inspect(linkedInstanceId) === "running"
        );
        if (currentRuntimeRunning) {
          skipped += 1;
          continue;
        }
        if (!await this.retireRuntimeWhenDrained(node)) {
          skipped += 1;
          continue;
        }
        if (linkedInstanceId) await provider.stop(linkedInstanceId);
        this.instances.delete(node.id);
      }
      const tracked = this.instances.get(node.id);
      if (tracked) {
        const trackedRunning = await tracked.provider.inspect(tracked.instance.id) === "running";
        if (tracked.generation !== node.generation) {
          if (trackedRunning) await tracked.provider.stop(tracked.instance.id);
          this.instances.delete(node.id);
        } else if (trackedRunning) {
          skipped += 1;
          continue;
        } else {
          this.instances.delete(node.id);
        }
      }
      if (node.activeAttemptId) {
        const active = attempts.find((attempt) => attempt.id === node.activeAttemptId);
        if (active?.providerInstanceId && await provider.inspect(active.providerInstanceId) === "running") {
          skipped += 1;
          continue;
        }
        if (active) {
          const retryDelayMs = provisioningRetryDelayMs(
            active.attemptNumber,
            this.retryBaseMs,
            this.retryMaxMs,
          );
          await this.backend.updateProvisioningAttempt(node.id, active.id, {
            status: "failed",
            errorCode: "controller_recovered_unknown_instance",
            errorMessage: "The controller could not recover the provider instance; a new attempt will be created.",
            retryAt: new Date(this.now() + retryDelayMs).toISOString(),
          });
          this.logger?.warn("managed node provider instance disappeared", {
            nodeId: node.id,
            provider: node.provider,
            retryDelayMs,
          });
          failed += 1;
          continue;
        }
      }
      const retryAt = provisioningRetryAt(attempts, node.generation);
      if (retryAt !== undefined && retryAt > this.now()) {
        this.logger?.warn("managed node provisioning is backing off", {
          nodeId: node.id,
          provider: node.provider,
          retryInMs: retryAt - this.now(),
        });
        skipped += 1;
        continue;
      }
      let created: Awaited<ReturnType<ManagedNodeBackend["createProvisioningAttempt"]>> | undefined;
      try {
        created = await this.backend.createProvisioningAttempt(node.id);
        await this.backend.updateProvisioningAttempt(node.id, created.attempt.id, { status: "allocating" });
        const instance = await provider.ensure({
          node,
          attempt: created.attempt,
          backendUrl: this.backendUrl,
          enrollmentCredential: created.enrollmentCredential,
          workspacePath: this.workspacePathForNode(node),
          workspaceId: workspaceIdForManagedNode(node),
        });
        this.instances.set(node.id, { provider, instance, generation: node.generation });
        await this.backend.updateProvisioningAttempt(node.id, created.attempt.id, {
          status: "registering",
          providerInstanceId: instance.id,
        });
        started += 1;
      } catch (error) {
        failed += 1;
        const retryDelayMs = provisioningRetryDelayMs(
          created?.attempt.attemptNumber ?? 1,
          this.retryBaseMs,
          this.retryMaxMs,
        );
        if (created) {
          await this.backend.updateProvisioningAttempt(node.id, created.attempt.id, {
            status: "failed",
            errorCode: "provider_ensure_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            retryAt: new Date(this.now() + retryDelayMs).toISOString(),
          }).catch(() => undefined);
        }
        this.logger?.error("managed node reconcile failed", {
          nodeId: node.id,
          provider: node.provider,
          retryDelayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      } catch (error) {
        failed += 1;
        this.logger?.error("managed node reconcile failed", {
          nodeId: node.id,
          provider: node.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { nodes: nodes.length, started, skipped, healthy, failed };
  }

  private async retireRuntimeWhenDrained(node: ManagedNodeRecord): Promise<boolean> {
    try {
      await this.backend.retireManagedNodeRuntime(node.id);
      return true;
    } catch (error) {
      if (!isConflictResponse(error)) throw error;
      this.logger?.warn("managed node runtime retirement blocked", {
        nodeId: node.id,
        daemonNodeId: node.activeDaemonNodeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async stop(): Promise<void> {
    // The supervisor is a disposable controller, not the owner of Computer
    // desired state. Process shutdown only drops local bookkeeping. Provider
    // instances are stopped exclusively by durable stopped/deleted intent or
    // an explicit replacement in reconcileOnce().
    this.instances.clear();
  }
}

function isConflictResponse(error: unknown): error is { status: 409 } {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && error.status === 409;
}
