import styles from "./obs-setup-guide.module.scss";

export const ObsSetupGuide = () => (
    <details className={styles.guide}>
        <summary>Инструкция по настройке OBS и автопереключения</summary>
        <div className={styles.content}>
            <div className={styles.notice}>
                Сайт не получает пароль OBS. Сценами управляет Companion напрямую
                через локальный OBS WebSocket.
            </div>
            <ol>
                <li>
                    <strong>Создайте три сцены OBS</strong>
                    <code>Dota — Между матчами</code>
                    <code>Dota — Драфт</code>
                    <code>Dota — Игра</code>
                </li>
                <li>
                    <strong>Добавьте источники</strong>
                    В «Драфт» и «Игра» добавьте Game Capture, камеру и Browser
                    Source. В сцене «Между матчами» Browser Source занимает весь
                    экран, а камера остаётся отдельным источником OBS.
                </li>
                <li>
                    <strong>Используйте один Browser Source</strong>
                    Вставьте OBS URL из блока выше, задайте 1920 × 1080. В
                    остальных сценах выбирайте «Добавить существующий», чтобы OBS
                    не создавал несколько копий страницы.
                </li>
                <li>
                    <strong>Включите OBS WebSocket</strong>
                    Откройте «Инструменты → Настройки сервера WebSocket», включите
                    сервер, оставьте адрес <code>127.0.0.1</code> и порт{" "}
                    <code>4455</code>, задайте пароль.
                </li>
                <li>
                    <strong>Настройте Companion</strong>
                    В блоке «Сцены OBS» укажите порт, пароль и точные названия
                    сцен. Нажмите «Сохранить», затем «Проверить подключение» и
                    включите автоматическое переключение.
                </li>
            </ol>
            <div className={styles.flow}>
                <span>Меню / после игры</span><b>→</b><code>Dota — Между матчами</code>
                <span>Выбор героев</span><b>→</b><code>Dota — Драфт</code>
                <span>Начало матча</span><b>→</b><code>Dota — Игра</code>
            </div>
        </div>
    </details>
);
