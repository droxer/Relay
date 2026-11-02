"use client";

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { changePassword, updateAccountProfile } from "../../api";
import type { CurrentUser } from "../../types";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "../../lib/passwordPolicy";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
      <form className="account-settings-form" onSubmit={(event) => void saveProfile(event)} aria-labelledby="account-profile-title" aria-busy={profileBusy}>
        <div>
          <h3 id="account-profile-title">{t("account.profile")}</h3>
          <p className="account-settings-hint">{t("account.profile_hint")}</p>
        </div>
        <Field label={t("account.username")}>
          <Input value={user.username} readOnly autoComplete="username" />
        </Field>
        <Field label={t("account.display_name")}>
          <Input value={name} onChange={(event) => { setName(event.target.value); setProfileSaved(false); setProfileError(""); }} required maxLength={100} autoComplete="nickname" disabled={profileBusy} />
        </Field>
        {profileError && <p className="account-settings-error" role="alert">{profileError}</p>}
        <div className="account-settings-actions">
          <Button type="submit" loading={profileBusy} disabled={profileBusy || !name.trim() || name.trim() === (user.displayName ?? user.username)}>{t("account.save_name")}</Button>
          {profileSaved && <p role="status">{t("account.name_saved")}</p>}
        </div>
      </form>
      <form className="account-settings-form" onSubmit={(event) => void savePassword(event)} aria-labelledby="account-password-title" aria-busy={passwordBusy}>
        <div>
          <h3 id="account-password-title">{t("account.change_password")}</h3>
          <p className="account-settings-hint">{t("account.password_hint", { min: MIN_PASSWORD_LENGTH })}</p>
        </div>
        <Input className="sr-only" tabIndex={-1} aria-hidden="true" value={user.username} readOnly autoComplete="username" />
        <Field label={t("account.current_password")}>
          <Input type="password" value={current} onChange={(event) => { setCurrent(event.target.value); setPasswordSaved(false); setPasswordError(""); }} autoComplete="current-password" required maxLength={MAX_PASSWORD_LENGTH} disabled={passwordBusy} />
        </Field>
        <Field label={t("account.new_password")}>
          <Input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setPasswordSaved(false); setPasswordError(""); }} autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} disabled={passwordBusy} />
        </Field>
        <Field label={t("account.confirm_password")}>
          <Input type="password" value={confirm} onChange={(event) => { setConfirm(event.target.value); setPasswordSaved(false); setPasswordError(""); }} autoComplete="new-password" required maxLength={MAX_PASSWORD_LENGTH} disabled={passwordBusy} />
        </Field>
        <p className="account-settings-hint">{t("account.sessions_hint")}</p>
        {passwordError && <p className="account-settings-error" role="alert">{passwordError}</p>}
        <div className="account-settings-actions">
          <Button type="submit" loading={passwordBusy} disabled={passwordBusy || !current || !password || !confirm}>{t("account.change_password")}</Button>
          {passwordSaved && <p role="status">{t("account.password_saved")}</p>}
        </div>
      </form>
    </div>
  );
}
