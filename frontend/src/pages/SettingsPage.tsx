import { useEffect, useState } from "react";
import { Check, LogOut, Save, ShieldCheck, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import type { User } from "@supabase/supabase-js";
import { setLanguage, supportedLanguages, useI18n } from "../i18n/i18n";

type ThemeMode = "light" | "dark" | "system";
type Profile = {
  user_id: string;
  display_name: string;
  username: string;
  avatar_url: string;
  bio: string;
  education_level: string;
  grade: string;
  school_name: string;
  city: string;
  country: string;
  study_session_duration: string;
  study_method: string;
  difficulty: string;
  study_goal: string;
  theme: ThemeMode;
  language: string;
  notification_preferences: {
    revision: boolean;
    homework: boolean;
    tests: boolean;
    general: boolean;
  };
};
const emptyProfile = (user: User): Profile => ({
  user_id: user.id,
  display_name: user.user_metadata?.full_name ?? "",
  username: user.user_metadata?.username ?? "",
  avatar_url: "",
  bio: "",
  education_level: "",
  grade: "",
  school_name: "",
  city: "",
  country: "",
  study_session_duration: "30",
  study_method: "mix",
  difficulty: "adaptive",
  study_goal: "understand",
  theme: "system",
  language: "fr",
  notification_preferences: {
    revision: true,
    homework: true,
    tests: true,
    general: true,
  },
});
const gradeOptions: Record<string, string[]> = {
  Primaire: ["CP", "CE1", "CE2", "CM1", "CM2"],
  Collège: ["6e", "5e", "4e", "3e"],
  Lycée: ["Seconde", "Première", "Terminale"],
  "Études supérieures": [
    "Bac +1",
    "Bac +2",
    "Bac +3",
    "Bac +4",
    "Bac +5",
    "Bac +6 et plus",
  ],
};
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function SettingsPage({
  user,
  initialDark,
  onThemeChange,
  onSignOut,
}: {
  user: User;
  initialDark: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onSignOut: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<Profile>(() => ({
    ...emptyProfile(user),
    theme: initialDark ? "dark" : "light",
  }));
  const [email, setEmail] = useState(user.email ?? "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error: loadError } = await supabase
          .from("profiles")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!active) return;
        if (loadError) setError(t("errors.profileLoad"));
        if (data) {
          const preferences = data.study_preferences ?? {};
          setProfile((current) => ({
            ...current,
            user_id: user.id,
            display_name: data.display_name ?? current.display_name,
            education_level: data.education_level ?? current.education_level,
            grade: data.grade ?? current.grade,
            school_name: data.school ?? data.school_name ?? current.school_name,
            city: data.city ?? current.city,
            country: data.country ?? current.country,
            language: data.language ?? current.language,
            study_session_duration:
              preferences.session_duration ?? current.study_session_duration,
            study_method: preferences.method ?? current.study_method,
            difficulty: preferences.difficulty ?? current.difficulty,
            study_goal: preferences.goal ?? current.study_goal,
            theme: preferences.theme ?? current.theme,
            notification_preferences: {
              ...current.notification_preferences,
              ...(data.notification_preferences ?? {}),
            },
          }));
          if (data.language) setLanguage(data.language);
        }
      } catch {
        if (active) setError(t("errors.settingsLoad"));
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [user, t]);
  const update = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((current) => ({ ...current, [key]: value }));
  const updateNotification = (
    key: keyof Profile["notification_preferences"],
    value: boolean,
  ) =>
    update("notification_preferences", {
      ...profile.notification_preferences,
      [key]: value,
    });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const { data: authData, error: authError } =
        await supabase.auth.getUser();
      if (authError) throw authError;
      if (!authData.user?.id) throw new Error(t("errors.noUser"));
      const payload = {
        user_id: authData.user.id,
        display_name: profile.display_name,
        education_level: profile.education_level,
        grade: profile.grade,
        school: profile.school_name,
        city: profile.city,
        country: profile.country,
        language: profile.language,
        study_preferences: {
          session_duration: profile.study_session_duration,
          method: profile.study_method,
          difficulty: profile.difficulty,
          goal: profile.study_goal,
          theme: profile.theme,
        },
        notification_preferences: profile.notification_preferences,
      };
      const { error: saveError } = await supabase
        .from("profiles")
        .upsert(payload, { onConflict: "user_id" });
      if (saveError) throw saveError;
      setLanguage(profile.language);
      onThemeChange(profile.theme);
      setMessage(t("settings.saved"));
    } catch (err) {
      const details = err as {
        message?: string;
        code?: string;
        details?: string;
        hint?: string;
      };
      console.error(details);
      setError(errorMessage(err, t("errors.settingsSave")));
    } finally {
      setSaving(false);
    }
  };
  const updatePassword = async () => {
    setAccountMessage("");
    setError("");
    if (password.length < 6) return setError(t("errors.passwordShort"));
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) setError(updateError.message);
    else {
      setPassword("");
      setAccountMessage(t("settings.saved"));
    }
  };
  const updateEmail = async () => {
    if (!email.trim() || email === user.email) return;
    const { error: updateError } = await supabase.auth.updateUser({
      email: email.trim(),
    });
    if (updateError) setError(updateError.message);
    else setAccountMessage(t("settings.saved"));
  };
  const deleteAccount = async () => {
    if (!window.confirm(t("confirm.deleteAccount"))) return;
    const { error: deleteError } = await supabase.rpc("delete_my_account");
    if (deleteError) setError(t("confirm.deleteAccountError"));
    else await onSignOut();
  };
  if (loading)
    return (
      <section className="settings-page">
        <div className="settings-loading">{t("settings.loading")}</div>
      </section>
    );
  return (
    <section className="settings-page">
      <div className="eyebrow">
        {t("settings.eyebrow")} <span className="status-dot" />{" "}
        {t("settings.title").toUpperCase()}
      </div>
      <div className="settings-heading">
        <div>
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.subtitle")}</p>
        </div>
        <button
          type="submit"
          form="settings-form"
          className="primary-button"
          disabled={saving}
        >
          <Save size={16} />{" "}
          {saving ? t("settings.saving") : t("settings.save")}
        </button>
      </div>
      {error && (
        <div className="alert">
          <span>{error}</span>
        </div>
      )}
      {message && (
        <div className="success-alert">
          <Check size={16} /> {message}
        </div>
      )}
      <form id="settings-form" className="settings-layout" onSubmit={save}>
        <div className="settings-main">
          <SettingsSection
            title={t("settings.profile")}
            description={t("settings.profileDescription")}
          >
            <div className="settings-grid">
              <Field label={t("settings.displayName")}>
                <input
                  value={profile.display_name}
                  onChange={(event) =>
                    update("display_name", event.target.value)
                  }
                />
              </Field>
              <Field label={t("settings.username")}>
                <input
                  value={profile.username}
                  onChange={(event) => update("username", event.target.value)}
                />
              </Field>
              <Field label={t("settings.avatar")}>
                <input
                  type="url"
                  value={profile.avatar_url}
                  onChange={(event) => update("avatar_url", event.target.value)}
                />
              </Field>
              <Field label={t("settings.bio")}>
                <textarea
                  value={profile.bio}
                  onChange={(event) => update("bio", event.target.value)}
                  rows={3}
                />
              </Field>
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("settings.schooling")}
            description={t("settings.schoolingDescription")}
          >
            <div className="settings-grid">
              <Field label={t("settings.level")}>
                <select
                  value={profile.education_level}
                  onChange={(event) => {
                    update("education_level", event.target.value);
                    update("grade", "");
                  }}
                >
                  <option value="">{t("settings.chooseClass")}</option>
                  {Object.keys(gradeOptions).map((level) => (
                    <option key={level} value={level}>
                      {t(level === "Primaire" ? "settings.primary" : level === "Collège" ? "settings.middle" : level === "Lycée" ? "settings.high" : "settings.higher")}
                    </option>
                  ))}
                  <option value="Autre">{t("settings.other")}</option>
                </select>
              </Field>
              <Field label={t("settings.grade")}>
                <select
                  value={
                    gradeOptions[profile.education_level]?.includes(
                      profile.grade,
                    )
                      ? profile.grade
                      : ""
                  }
                  onChange={(event) => update("grade", event.target.value)}
                  disabled={!profile.education_level}
                >
                  <option value="">{t("settings.choose")}</option>
                  {(gradeOptions[profile.education_level] ?? []).map(
                    (grade) => (
                      <option key={grade} value={grade}>
                        {grade}
                      </option>
                    ),
                  )}
                </select>
              </Field>
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("settings.preferences")}
            description={t("settings.notificationsDescription")}
          >
            <div className="settings-grid">
              <Field label={t("settings.session")}>
                <select
                  value={profile.study_session_duration}
                  onChange={(event) =>
                    update("study_session_duration", event.target.value)
                  }
                >
                  {["15", "30", "45", "60", "90", "120"].map((value) => (
                    <option key={value} value={value}>
                      {value} min
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("settings.method")}>
                <select
                  value={profile.study_method}
                  onChange={(event) =>
                    update("study_method", event.target.value)
                  }
                >
                  {[
                    "cards",
                    "quiz",
                    "qa",
                    "exercises",
                    "flashcards",
                    "mix",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {t(`settings.${value}` as Parameters<typeof t>[0])}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("settings.difficulty")}>
                <select
                  value={profile.difficulty}
                  onChange={(event) => update("difficulty", event.target.value)}
                >
                  {["easy", "intermediate", "hard", "adaptive"].map((value) => (
                    <option key={value} value={value}>
                      {t(`settings.${value}` as Parameters<typeof t>[0])}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("settings.goal")}>
                <select
                  value={profile.study_goal}
                  onChange={(event) => update("study_goal", event.target.value)}
                >
                  {[
                    "understand",
                    "grades",
                    "test",
                    "exam",
                    "memory",
                    "organize",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {t(`settings.${value}` as Parameters<typeof t>[0])}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </SettingsSection>
        </div>
        <aside className="settings-side">
          <SettingsSection
            title={t("settings.preferences")}
            description={t("settings.profileDescription")}
          >
            <div className="segmented-control">
              {(["light", "dark", "system"] as ThemeMode[]).map((theme) => (
                <button
                  type="button"
                  key={theme}
                  className={profile.theme === theme ? "active" : ""}
                  onClick={() => {
                    update("theme", theme);
                    onThemeChange(theme);
                  }}
                >
                  {t(`settings.${theme}` as Parameters<typeof t>[0])}
                </button>
              ))}
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("settings.language")}
            description={t("settings.profileDescription")}
          >
            <select
              value={profile.language}
              onChange={(event) => {
                update("language", event.target.value);
                setLanguage(event.target.value);
              }}
            >
              {supportedLanguages.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </SettingsSection>
          <SettingsSection
            title={t("settings.notifications")}
            description={t("settings.notificationsDescription")}
          >
            <div className="toggle-list">
              {(
                [
                  ["revision", "settings.revisions"],
                  ["homework", "settings.homework"],
                  ["tests", "settings.tests"],
                  ["general", "settings.general"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={profile.notification_preferences[key]}
                    onChange={(event) =>
                      updateNotification(key, event.target.checked)
                    }
                  />
                  <span>{t(label)}</span>
                </label>
              ))}
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("settings.account")}
            description={accountMessage || t("settings.profileDescription")}
          >
            <div className="account-actions">
              <Field label={t("settings.email")}>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void updateEmail()}
                >
                  {t("settings.changeEmail")}
                </button>
              </Field>
              <Field label={t("settings.password")}>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("auth.passwordHint")}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void updatePassword()}
                >
                  {t("settings.changePassword")}
                </button>
              </Field>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onSignOut()}
              >
                <LogOut size={16} /> {t("top.logout")}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void deleteAccount()}
              >
                <Trash2 size={16} /> {t("settings.deleteAccount")}
              </button>
            </div>
          </SettingsSection>
          <div className="privacy-note">
            <ShieldCheck size={18} />
            <span>{t("settings.profileDescription")}</span>
          </div>
        </aside>
      </form>
    </section>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
