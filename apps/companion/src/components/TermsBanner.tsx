import * as api from "../services/dotaCompanionApi";

interface Props {
  show: boolean;
  version: string | null;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
}

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// WK-191 - asks an account that hasn't accepted the user agreement in force
// (created before it was published, or a new edition) to accept it. Both
// documents open on the site in the system browser. No "later" button and
// no blocking: the banner stays until accepted, and everything else in
// Companion keeps working. Same banner shape as UpdateBanner.
export function TermsBanner({ show, version, busy, error, onAccept }: Props) {
  if (!show || !version) return null;

  return (
    <section className="update-banner update-banner--available" aria-label="Пользовательское соглашение">
      <div>
        <strong>С {formatDate(version)} действует пользовательское соглашение</strong>
        <p className="update-banner__notes">
          Ознакомьтесь с{" "}
          <button type="button" className="link-button" onClick={() => void api.openLegalDocument("terms")}>соглашением</button>
          {" "}и{" "}
          <button type="button" className="link-button" onClick={() => void api.openLegalDocument("privacy")}>политикой обработки персональных данных</button>
          {" "}и подтвердите, что принимаете соглашение. Если вы не согласны, аккаунт можно удалить в личном кабинете на сайте.
        </p>
        {error && <p className="update-banner__notes update-banner__error" role="alert">{error}</p>}
      </div>
      <div className="update-banner__actions">
        <button className="button button--primary" onClick={onAccept} disabled={busy}>Принимаю</button>
      </div>
    </section>
  );
}
