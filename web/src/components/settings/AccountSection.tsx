"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { changePassword, updateAccountProfile } from "../../api";
import type { CurrentUser } from "../../types";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "../../lib/passwordPolicy";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "../UserAvatar";

const IDENTITY_AVATAR_SIZE = 48;

/** Who is signed in: the saved name, never the draft being typed. */
function AccountIdentity({ user }: { user: CurrentUser }) {
  const name = user.displayName ?? user.username;
  return (
    <div className="account-identity">
      <UserAvatar displayName={name} running={false} size={IDENTITY_AVATAR_SIZE} />
      <div className="account-identity-copy">
        <p className="account-identity-name">{name}</p>
        <p className="account-identity-meta">
          <span>@{user.username}</span>
          {user.email ? <span>{user.email}</span> : null}
        </p>
      </div>
    </div>
  );
}

/** A group label over a framed panel, the same grammar as the notification
    and appearance option lists. The footer holds the panel's one action. */
function AccountPanel({ id, title, footer, children }: {
  id: string;
  title: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <h3 id={id} className="pref-group-label">{title}</h3>
      <div className="account-panel">
        <div className="account-panel-body">{children}</div>
        <div className="account-panel-footer">{footer}</div>
      </div>
    </>
  );
}

export function AccountSection({ user, onUserChange }: {
  user: CurrentUser;
  onUserChange: (user: CurrentUser) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(user.displayName ?? user.username);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (profileBusy || !name.trim()) return;
    setProfileBusy(true);
    setProfileError("");
    setProfileSaved(false);
    try {
      const result = await updateAccountProfile({ displayName: name.trim() });
      onUserChange(result.user);
      setName(result.user.displayName ?? result.user.username);
      setProfileSaved(true);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : t("account.save_error"));
    } finally { setProfileBusy(false); }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (passwordBusy) return;
    setPasswordSaved(false);
    const problem = passwordProblem(password, [user.username, user.displayName, user.email]);
    if (problem || password !== confirm || password === current) {
      setPasswordError(problem
        ? t(`waitlist.password_problem_${problem}`, { min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })
        : t(password !== confirm ? "account.password_mismatch" : "account.password_same"));
      return;
    }
    setPasswordBusy(true);
    setPasswordError("");
    try {
      await changePassword({ currentPassword: current, newPassword: password });
      setCurrent(""); setPassword(""); setConfirm("");
      setPasswordSaved(true);
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : t("account.save_error"));
    } finally { setPasswordBusy(false); }
  }

  return (
    <div className="account-settings">
      <AccountIdentity user={user} />

      <form className="account-group" onSubmit={(event) => void saveProfile(event)} aria-labelledby="account-profile-title" aria-busy={profileBusy}>
        <AccountPanel
          id="account-profile-title"
          title={t("account.profile")}
          footer={<>
            {profileSaved ? <p className="account-panel-note" role="status">{t("account.name_saved")}</p> : <span className="account-panel-note" />}
            <Button type="submit" loading={profileBusy} disabled={profileBusy || !name.trim() || name.trim() === (user.displayName ?? user.username)}>{t("account.save_name")}</Button>
          </>}
        >
          <Field label={t("account.display_name")}>
            <Input aria-describedby="account-profile-hint" value={name} onChange={(event) => { setName(event.target.value); setProfileSaved(false); setProfileError(""); }} required maxLength={100} autoComplete="nickname" disabled={profileBusy} />
          </Field>
          <p id="account-profile-hint" className="account-field-hint">{t("account.profile_hint")}</p>
          {profileError && <p className="account-settings-error" role="alert">{profileError}</p>}
        </AccountPanel>
      </form>

      <form className="account-group" onSubmit={(event) => void savePassword(event)} aria-labelledby="account-password-title" aria-busy={passwordBusy}>
        <AccountPanel
          id="account-password-title"
          title={t("account.change_password")}
          footer={<>
            {passwordSaved
              ? <p className="account-panel-note" role="status">{t("account.password_saved")}</p>
              : <p className="account-panel-note">{t("account.sessions_hint")}</p>}
            <Button type="submit" loading={passwordBusy} disabled={passwordBusy || !current || !password || !confirm}>{t("account.change_password")}</Button>
          </>}
        >
          <Input className="sr-only" tabIndex={-1} aria-hidden="true" value={user.username} readOnly autoComplete="username" />
          <Field label={t("account.current_password")}>
            <Input type="password" value={current} onChange={(event) => { setCurrent(event.target.value); setPasswordSaved(false); setPasswordError(""); }} autoComplete="current-password" required maxLength={MAX_PASSWORD_LENGTH} disabled={passwordBusy} />
          </Field>
          <Field label={t("account.new_password")}>
            <Input type="password" aria-describedby="account-password-hint" value={password} onChange={(event) => { setPassword(event.target.value); setPasswordSaved(false); setPasswordError(""); }} autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} disabled={passwordBusy} />
          </Field>
          <p id="account-password-hint" className="account-field-hint">{t("account.password_hint", { min: MIN_PASSWORD_LENGTH })}</p>
          <Field label={t("account.confirm_password")}>
            <Input type="password" value={confirm} onChange={(event) => { setConfirm(event.target.value); setPasswordSaved(false); setPasswordError(""); }} autoComplete="new-password" required maxLength={MAX_PASSWORD_LENGTH} disabled={passwordBusy} />
          </Field>
          {passwordError && <p className="account-settings-error" role="alert">{passwordError}</p>}
        </AccountPanel>
      </form>

      <section className="account-group" aria-labelledby="account-connections-title">
        <h3 id="account-connections-title" className="pref-group-label">{t("account.connections")}</h3>
        <a className="pref-option-label" href="/settings/connections">{t("connections.title")}</a>
      </section>
    </div>
  );
}
