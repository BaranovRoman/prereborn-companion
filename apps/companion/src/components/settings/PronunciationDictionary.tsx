import { useId, useMemo, useState } from "react";
import { speechTextFor } from "../../chat/chat-model";
import {
  BUILT_IN_PRONUNCIATIONS, MAX_SOURCE_LENGTH, MAX_SPOKEN_LENGTH, newPronunciationRuleId, validatePronunciationRule,
  type PronunciationRule, type PronunciationScope, type SpeechAuthor,
} from "../../chat/pronunciation";
import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import { Badge, Button, Field, Input, Notice, Select, Switch } from "../ui";

interface Chatter { id: string | null; login: string; name: string }
interface Draft { source: string; spoken: string; scope: "global" | "user"; login: string }
const EMPTY_DRAFT: Draft = { source: "", spoken: "", scope: "global", login: "" };
const PREVIEW_SAMPLE = "хз, ахахаха +25";

const loginOf = (value: string) => value.trim().replace(/^@/, "").toLowerCase();

// WK-184 - "Озвучка" > dictionary. Edits ChatSettings.pronunciationRules
// through the same session the TTS queue reads, so a saved rule applies to
// the next spoken message with no restart. Only the speech copy changes.
export function PronunciationDictionary({ session }: { session: TwitchChatSession }) {
  const { settings, updateSetting, previewSpeech, previewBusy, previewError, sileroStatus } = session;
  const rules = settings.pronunciationRules;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState(PREVIEW_SAMPLE);
  const [sampleAuthor, setSampleAuthor] = useState("");
  const chattersId = useId();

  // Recent chatters carry Twitch's stable user id; picking one binds a
  // personal rule to that id instead of a nickname that can change.
  const chatters = useMemo(() => {
    const byLogin = new Map<string, Chatter>();
    for (const message of session.status?.messages ?? []) {
      const login = loginOf(message.authorLogin ?? message.author);
      if (login) byLogin.set(login, { id: message.authorId, login, name: message.author });
    }
    return [...byLogin.values()];
  }, [session.status?.messages]);
  const chatterFor = (login: string) => chatters.find((c) => c.login === loginOf(login));

  const setRules = (next: PronunciationRule[]) => updateSetting("pronunciationRules", next);
  const scopeOf = (value: Draft): PronunciationScope => value.scope === "global"
    ? { kind: "global" }
    : { kind: "user", login: loginOf(value.login), userId: chatterFor(value.login)?.id ?? null };

  const change = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); setError(null); };
  const save = () => {
    const existing = editingId ? rules.find((rule) => rule.id === editingId) : undefined;
    let scope = scopeOf(draft);
    // Keep a previously bound id while the viewer isn't in the recent chat.
    if (scope.kind === "user" && !scope.userId && existing?.scope.kind === "user" && loginOf(existing.scope.login) === scope.login) {
      scope = { ...scope, userId: existing.scope.userId };
    }
    const candidate = { source: draft.source.trim(), spoken: draft.spoken.trim(), scope };
    const problem = validatePronunciationRule(candidate, rules, editingId ?? undefined);
    if (problem) { setError(problem); return; }
    setRules(existing
      ? rules.map((rule) => (rule.id === existing.id ? { ...rule, ...candidate } : rule))
      : [...rules, { id: newPronunciationRuleId(), enabled: true, ...candidate }]);
    setDraft(EMPTY_DRAFT); setEditingId(null); setError(null);
  };
  const edit = (rule: PronunciationRule) => {
    setEditingId(rule.id); setError(null);
    setDraft({ source: rule.source, spoken: rule.spoken, scope: rule.scope.kind, login: rule.scope.kind === "user" ? rule.scope.login : "" });
  };
  const cancel = () => { setDraft(EMPTY_DRAFT); setEditingId(null); setError(null); };
  const remove = (id: string) => { setRules(rules.filter((rule) => rule.id !== id)); if (editingId === id) cancel(); };
  const toggle = (id: string, enabled: boolean) => setRules(rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)));

  const previewAuthor: SpeechAuthor | undefined = sampleAuthor.trim()
    ? { id: chatterFor(sampleAuthor)?.id ?? null, login: loginOf(sampleAuthor), name: sampleAuthor.trim() }
    : undefined;
  const spoken = speechTextFor(sample, settings, previewAuthor);
  const sileroNotReady = settings.ttsEngine === "silero" && !sileroStatus?.resourcesReady;

  return (
    <div className="pronunciation">
      <datalist id={chattersId}>{chatters.map((c) => <option key={c.login} value={c.login}>{c.name}</option>)}</datalist>

      <div className="pronunciation__preview">
        <div className="pronunciation__preview-fields">
          <Field label="Проверить фразу"><Input value={sample} maxLength={300} onChange={(e) => setSample(e.target.value)} /></Field>
          <Field label="От зрителя"><Input value={sampleAuthor} list={chattersId} placeholder="ник, необязательно" onChange={(e) => setSampleAuthor(e.target.value)} /></Field>
        </div>
        <div className="pronunciation__result">
          <p aria-live="polite"><span className="ui-text-muted">Озвучится:</span> {spoken || <span className="ui-text-muted">ничего — сообщение будет пропущено</span>}</p>
          <Button size="small" onClick={() => previewSpeech(spoken)} disabled={!spoken || previewBusy || sileroNotReady}>{previewBusy ? "Синтез…" : "Прослушать"}</Button>
        </div>
        {previewError && <Notice tone="danger">Не удалось воспроизвести пример: {previewError}</Notice>}
      </div>

      {rules.length > 0 ? <ul className="pronunciation__list" aria-label="Правила произношения">
        {rules.map((rule) => <li key={rule.id} className={`pronunciation__rule${rule.enabled ? "" : " is-off"}${editingId === rule.id ? " is-editing" : ""}`}>
          <Switch aria-label={`Правило «${rule.source}» включено`} checked={rule.enabled} onChange={(e) => toggle(rule.id, e.target.checked)} />
          <span className="pronunciation__pair"><span>{rule.source}</span><span aria-hidden="true">→</span><span>{rule.spoken}</span></span>
          {rule.scope.kind === "user" ? <Badge>@{rule.scope.login}</Badge> : <Badge>Все сообщения</Badge>}
          <span className="pronunciation__actions">
            <Button size="small" variant="ghost" onClick={() => edit(rule)}>Изменить</Button>
            <Button size="small" variant="ghost" onClick={() => remove(rule.id)} aria-label={`Удалить правило «${rule.source}»`}>Удалить</Button>
          </span>
        </li>)}
      </ul> : <p className="ui-text-muted pronunciation__empty">Своих правил пока нет.</p>}

      <form className="pronunciation__form" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={editingId ? "Изменить правило" : "Новое правило"}>
        <h3 className="ui-settings-group__title pronunciation__form-title">{editingId ? "Изменение правила" : "Новое правило"}</h3>
        <Field label="Исходный текст"><Input value={draft.source} maxLength={MAX_SOURCE_LENGTH} placeholder="имба" onChange={(e) => change({ source: e.target.value })} /></Field>
        <Field label="Произносить как"><Input value={draft.spoken} maxLength={MAX_SPOKEN_LENGTH} placeholder="и+мба" onChange={(e) => change({ spoken: e.target.value })} /></Field>
        <Field label="Где действует">
          <Select value={draft.scope} onChange={(e) => change({ scope: e.target.value as Draft["scope"] })}>
            <option value="global">Все сообщения</option>
            <option value="user">Сообщения зрителя</option>
          </Select>
        </Field>
        {draft.scope === "user" && <Field label="Ник зрителя" hint={chatterFor(draft.login)?.id ? "Привязано к Twitch ID" : "Выберите из недавнего чата, чтобы привязать к Twitch ID"}>
          <Input value={draft.login} list={chattersId} placeholder="ник" onChange={(e) => change({ login: e.target.value })} />
        </Field>}
        <div className="pronunciation__form-actions">
          <Button type="submit" variant="primary">{editingId ? "Сохранить" : "Добавить правило"}</Button>
          {editingId && <Button onClick={cancel}>Отмена</Button>}
        </div>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}

      <p className="tts-license-note">
        Слова заменяются целиком, без учёта регистра. Сначала действуют правила зрителя, затем общие, затем встроенные
        ({BUILT_IN_PRONUNCIATIONS.map((rule) => `${rule.source} → ${rule.spoken}`).join(", ")}). Замена выполняется один раз и не применяется к уже заменённому тексту. «+» между буквами — ударение для Silero.
      </p>
    </div>
  );
}
