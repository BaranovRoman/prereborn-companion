import { pool } from "./client.js";

export const createTables = async (): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        public_token UUID UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // Refresh-С‚РѕРєРµРЅС‹ РѕС‚РґРµР»СЊРЅРѕР№ СЃРёСЃС‚РµРјС‹ СЃС‚СЂРёРј-Р°РєРєР°СѓРЅС‚РѕРІ. РҐСЂР°РЅРёС‚СЃСЏ С‚РѕР»СЊРєРѕ
        // sha256-С…СЌС€ (token_hash) - РєР°Рє РїР°СЂРѕР»СЊ, СЃР°Рј С‚РѕРєРµРЅ РЅРёРіРґРµ РЅР° СЃРµСЂРІРµСЂРµ
        // РЅРµ РѕСЃС‚Р°С‘С‚СЃСЏ РІ РѕС‚РєСЂС‹С‚РѕРј РІРёРґРµ. Р РѕС‚Р°С†РёСЏ РїСЂРё РєР°Р¶РґРѕРј /refresh (СЃРµСЂРІРёСЃ
        // СѓРґР°Р»СЏРµС‚ СЃС‚Р°СЂСѓСЋ СЃС‚СЂРѕРєСѓ Рё СЃРѕР·РґР°С‘С‚ РЅРѕРІСѓСЋ) РѕРіСЂР°РЅРёС‡РёРІР°РµС‚ СѓСЂРѕРЅ РѕС‚ РєСЂР°Р¶Рё
        // РѕРґРЅРѕРіРѕ refresh-С‚РѕРєРµРЅР° РѕРґРЅРёРј РёСЃРїРѕР»СЊР·РѕРІР°РЅРёРµРј.
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_refresh_tokens (
        id SERIAL PRIMARY KEY,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_refresh_tokens_user_id ON stream_refresh_tokens(stream_user_id);
    `);

        // РђРєС‚РёРІРЅР°СЏ СЃС‚СЂРёРј-СЃРµСЃСЃРёСЏ (С‚РµРєСѓС‰РёР№ СЂРµР№С‚РёРЅРі/W-L/РіРµСЂРѕР№) - РѕС‚РґРµР»СЊРЅР°СЏ РѕС‚
        // stream_users СЃСѓС‰РЅРѕСЃС‚СЊ, С‡С‚РѕР±С‹ РїРѕР·Р¶Рµ РјРѕР¶РЅРѕ Р±С‹Р»Рѕ С…СЂР°РЅРёС‚СЊ РёСЃС‚РѕСЂРёСЋ
        // РїСЂРѕС€Р»С‹С… СЃС‚СЂРёРјРѕРІ, РЅРµ СЂР°Р·РґСѓРІР°СЏ С‚Р°Р±Р»РёС†Сѓ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№. rating > 0
        // РёР»Рё NULL (РµС‰С‘ РЅРµ Р·Р°РґР°РЅ) - CHECK, Р° РЅРµ NOT NULL DEFAULT, С‚.Рє. РґРѕ
        // РїРµСЂРІРѕРіРѕ РІРІРѕРґР° СЂРµР№С‚РёРЅРіР° РѕРЅ РЅРµРёР·РІРµСЃС‚РµРЅ. wins/losses - РЅРµРѕС‚СЂРёС†Р°С‚РµР»СЊРЅС‹Рµ
        // СЃС‡С‘С‚С‡РёРєРё С‚РµРєСѓС‰РµРіРѕ СЃС‚СЂРёРјР°, СЃР±СЂР°СЃС‹РІР°СЋС‚СЃСЏ РЅР° "РќР°С‡Р°С‚СЊ РЅРѕРІС‹Р№ СЃС‚СЂРёРј"
        // (services/stream-session-service.ts), rating РјРµР¶РґСѓ СЃС‚СЂРёРјР°РјРё
        // РїРµСЂРµРЅРѕСЃРёС‚СЃСЏ. last_hero_id - РїСЂРѕРёР·РІРѕР»СЊРЅРѕРµ РїРѕР»РѕР¶РёС‚РµР»СЊРЅРѕРµ С‡РёСЃР»Рѕ, Р±РµР·
        // FK РЅР° СЃРїРёСЃРѕРє РіРµСЂРѕРµРІ: СЃРїСЂР°РІРѕС‡РЅРёРє РіРµСЂРѕРµРІ СЃС‚Р°С‚РёС‡РµСЃРєРёР№ Рё Р¶РёРІС‘С‚ С‚РѕР»СЊРєРѕ
        // РЅР° С„СЂРѕРЅС‚РµРЅРґРµ (entities/dota-hero) - Р±СЌРєРµРЅРґ РЅР°РјРµСЂРµРЅРЅРѕ РЅРµ Р·РЅР°РµС‚ РїСЂРѕ
        // Dota/OpenDota, С‡С‚РѕР±С‹ РЅРµ РїСЂРёРІСЏР·С‹РІР°С‚СЊСЃСЏ Рє РєРѕРЅРєСЂРµС‚РЅРѕРјСѓ РїСЂРѕРІР°Р№РґРµСЂСѓ.
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_sessions (
        id SERIAL PRIMARY KEY,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        rating INTEGER CHECK (rating IS NULL OR rating > 0),
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
        last_hero_id INTEGER CHECK (last_hero_id IS NULL OR last_hero_id > 0),
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_user_id ON stream_sessions(stream_user_id);
    `);
        // Partial unique index - Сѓ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ Р±РѕР»СЊС€Рµ РѕРґРЅРѕР№
        // СЃС‚СЂРѕРєРё СЃ ended_at IS NULL. Р“Р°СЂР°РЅС‚РёСЏ РЅР° СѓСЂРѕРІРЅРµ Р‘Р”, Р° РЅРµ С‚РѕР»СЊРєРѕ РІ
        // СЃРµСЂРІРёСЃРЅРѕРј РєРѕРґРµ: РґР°Р¶Рµ РїР°СЂР°Р»Р»РµР»СЊРЅС‹Рµ Р·Р°РїСЂРѕСЃС‹ РЅРµ СЃРјРѕРіСѓС‚ РїРѕСЂРѕРґРёС‚СЊ РґРІРµ
        // "Р°РєС‚РёРІРЅС‹Рµ" СЃРµСЃСЃРёРё РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ.
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_sessions_one_active_per_user
        ON stream_sessions(stream_user_id) WHERE ended_at IS NULL;
    `);

        // РџСЂРёРІСЏР·РєР° Steam (services/steam-openid-service.ts, controllers/stream/steam.ts).
        // steam_id64 - VARCHAR, РЅРµ С‡РёСЃР»Рѕ: РєР°Рє 64-Р±РёС‚РЅС‹Р№ ID, С‚Р°Рє Рё РѕР±С‹С‡РЅС‹Р№ JS
        // number РїРѕС‚РµСЂСЏР»Рё Р±С‹ С‚РѕС‡РЅРѕСЃС‚СЊ (> Number.MAX_SAFE_INTEGER). dota_account_id -
        // Steam32-С‡Р°СЃС‚СЊ, РІС‹С‡РёСЃР»СЏРµС‚СЃСЏ С†РµРЅС‚СЂР°Р»РёР·РѕРІР°РЅРЅРѕ РІ services/steam-id.ts,
        // СѓРєР»Р°РґС‹РІР°РµС‚СЃСЏ РІ BIGINT СЃ Р±РѕР»СЊС€РёРј Р·Р°РїР°СЃРѕРј. steam_connected_at - РјРѕРјРµРЅС‚
        // РїСЂРёРІСЏР·РєРё; РїРѕРјРёРјРѕ РѕС‡РµРІРёРґРЅРѕРіРѕ РЅР°Р·РЅР°С‡РµРЅРёСЏ, СЌС‚Рѕ Р¶Рµ РїРѕР»Рµ СЃР»СѓР¶РёС‚ "РІРѕРґСЏРЅС‹Рј
        // Р·РЅР°РєРѕРј" РїРµСЂРІРёС‡РЅРѕР№ СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё (services/dota-sync-service.ts) -
        // РјР°С‚С‡Рё РґРѕ СЌС‚РѕРіРѕ РјРѕРјРµРЅС‚Р° РЅРёРєРѕРіРґР° РЅРµ СѓС‡РёС‚С‹РІР°СЋС‚СЃСЏ РєР°Рє РјР°С‚С‡Рё СЃС‚СЂРёРјР°.
        await client.query(`
      ALTER TABLE stream_users ADD COLUMN IF NOT EXISTS steam_id64 VARCHAR(20);
      ALTER TABLE stream_users ADD COLUMN IF NOT EXISTS dota_account_id BIGINT;
      ALTER TABLE stream_users ADD COLUMN IF NOT EXISTS steam_connected_at TIMESTAMP;
    `);
        // WHERE steam_id64 IS NOT NULL - РїР°СЂС‚РёС†РёРѕРЅРЅС‹Р№, РєР°Рє Сѓ Р°РєС‚РёРІРЅС‹С… СЃРµСЃСЃРёР№:
        // РѕРґРёРЅ Steam-Р°РєРєР°СѓРЅС‚ РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ РїСЂРёРІСЏР·Р°РЅ Рє РґРІСѓРј stream-РїРѕР»СЊР·РѕРІР°С‚РµР»СЏРј
        // РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ, РЅРѕ РјРЅРѕР¶РµСЃС‚РІРѕ РµС‰С‘ РЅРµ РїСЂРёРІСЏР·Р°РЅРЅС‹С… РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№
        // (steam_id64 = NULL) РґСЂСѓРі РґСЂСѓРіСѓ РЅРµ РјРµС€Р°СЋС‚.
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_users_steam_id64
        ON stream_users(steam_id64) WHERE steam_id64 IS NOT NULL;
    `);

        // РћРґРЅРѕСЂР°Р·РѕРІС‹Р№ CSRF-state РґР»СЏ Steam OpenID connect-С„Р»РѕСѓ - С‚РѕС‚ Р¶Рµ РїР°С‚С‚РµСЂРЅ,
        // С‡С‚Рѕ Рё stream_refresh_tokens: СЃС‚СЂРѕРєР° СЃРѕР·РґР°С‘С‚СЃСЏ РїСЂРё GET
        // /integrations/steam/connect (РїРѕРєР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ С‚РѕС‡РЅРѕ Р°РІС‚РѕСЂРёР·РѕРІР°РЅ),
        // РїРѕС‚СЂРµР±Р»СЏРµС‚СЃСЏ (DELETE ... RETURNING) РІ /callback. РРјРµРЅРЅРѕ СЌС‚Р° Р·Р°РїРёСЃСЊ
        // СЃРІСЏР·С‹РІР°РµС‚ Р°РЅРѕРЅРёРјРЅС‹Р№ СЂРµРґРёСЂРµРєС‚ РѕС‚ Steam СЃ РєРѕРЅРєСЂРµС‚РЅС‹Рј stream_user_id -
        // Р±РµР· РЅРµС‘ callback РЅРµ РјРѕРі Р±С‹ Р·РЅР°С‚СЊ, РєРѕРјСѓ РїСЂРёРЅР°РґР»РµР¶РёС‚ РїСЂРёРІСЏР·РєР°.
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_steam_connect_states (
        id SERIAL PRIMARY KEY,
        state VARCHAR(64) UNIQUE NOT NULL,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // РќР°Р±Р»СЋРґР°РµРјРѕСЃС‚СЊ Рё UI ("РџРѕСЃР»РµРґРЅСЏСЏ СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёСЏ: 14:32", "РЎС‚Р°С‚СѓСЃ: РґР°РЅРЅС‹Рµ
        // Р°РєС‚СѓР°Р»СЊРЅС‹") СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё Dota-РјР°С‚С‡РµР№ - РїСЂРёРІСЏР·Р°РЅС‹ Рє СЃРµСЃСЃРёРё, Р° РЅРµ Рє
        // РїРѕР»СЊР·РѕРІР°С‚РµР»СЋ: Сѓ РЅРѕРІРѕР№ СЃРµСЃСЃРёРё (РїРѕСЃР»Рµ "РќР°С‡Р°С‚СЊ РЅРѕРІС‹Р№ СЃС‚СЂРёРј") РёСЃС‚РѕСЂРёСЏ
        // СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё Р»РѕРіРёС‡РЅРѕ РЅР°С‡РёРЅР°РµС‚СЃСЏ СЃ С‡РёСЃС‚РѕРіРѕ Р»РёСЃС‚Р°.
        await client.query(`
      ALTER TABLE stream_sessions ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
      ALTER TABLE stream_sessions ADD COLUMN IF NOT EXISTS last_sync_status VARCHAR(20)
        CHECK (last_sync_status IS NULL OR last_sync_status IN ('ok', 'not_found', 'rate_limited', 'unavailable'));
    `);

        // РћР±СЂР°Р±РѕС‚Р°РЅРЅС‹Рµ РјР°С‚С‡Рё Dota - Р·Р°С‰РёС‚Р° РѕС‚ РїРѕРІС‚РѕСЂРЅРѕРіРѕ СѓС‡С‘С‚Р° РѕРґРЅРѕРіРѕ РјР°С‚С‡Р°
        // (services/dota-sync-service.ts). РЈРЅРёРєР°Р»СЊРЅРѕСЃС‚СЊ РЅР° СѓСЂРѕРІРЅРµ (РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ,
        // РјР°С‚С‡), Р° РЅРµ С‚РѕР»СЊРєРѕ (СЃРµСЃСЃРёСЏ, РјР°С‚С‡): РґР°Р¶Рµ РµСЃР»Рё Р±С‹ РјР°С‚С‡ РєР°РєРёРј-С‚Рѕ РѕР±СЂР°Р·РѕРј
        // РїРѕРїР°Р» РІ РѕРєРЅРѕ СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё РІС‚РѕСЂРѕР№ СЂР°Р· РїРѕРґ РґСЂСѓРіРѕР№ СЃРµСЃСЃРёРµР№, РїРѕРІС‚РѕСЂРЅРѕ
        // Р·Р°СЃС‡РёС‚Р°РЅ РЅРµ Р±СѓРґРµС‚. match_id - BIGINT: node-postgres РІРѕР·РІСЂР°С‰Р°РµС‚ int8
        // СЃС‚СЂРѕРєРѕР№, С‡С‚Рѕ Рё С‚СЂРµР±СѓРµС‚СЃСЏ (id РјР°С‚С‡Р° РЅРµ РґРѕР»Р¶РµРЅ С‚РµСЂСЏС‚СЊ С‚РѕС‡РЅРѕСЃС‚СЊ).
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_match_events (
        id SERIAL PRIMARY KEY,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        stream_session_id INTEGER NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
        match_id BIGINT NOT NULL,
        hero_id INTEGER NOT NULL,
        is_win BOOLEAN NOT NULL,
        match_started_at TIMESTAMP NOT NULL,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_match_events_user_match
        ON stream_match_events(stream_user_id, match_id);
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_match_events_session
        ON stream_match_events(stream_session_id);
    `);

        // Companion token (apps/dota-companion desktop app) - РѕС‚РґРµР»СЊРЅС‹Р№ СЃРµРєСЂРµС‚
        // РѕС‚ public_token: С‚РѕС‚ РѕС‚РєСЂС‹С‚ РґР»СЏ С‡С‚РµРЅРёСЏ (OBS overlay), СЌС‚РѕС‚ РґР°С‘С‚ РїСЂР°РІРѕ
        // Р—РђРџРРЎР СЃРѕСЃС‚РѕСЏРЅРёСЏ С‡РµСЂРµР· PUT /api/stream/companion/gsi-state, РїРѕСЌС‚РѕРјСѓ
        // С…СЂР°РЅРёС‚СЃСЏ РєР°Рє sha256-С…СЌС€ (С‚РѕС‚ Р¶Рµ РїР°С‚С‚РµСЂРЅ, С‡С‚Рѕ Рё
        // stream_refresh_tokens.token_hash), Р° РЅРµ РІ РѕС‚РєСЂС‹С‚РѕРј РІРёРґРµ. РћРґРёРЅ С‚РѕРєРµРЅ
        // РЅР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ (РЅРµ С‚Р°Р±Р»РёС†Р° С‚РѕРєРµРЅРѕРІ) - СЂРµРіРµРЅРµСЂР°С†РёСЏ РїСЂРѕСЃС‚Рѕ
        // РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚ С…СЌС€, СЃС‚Р°СЂС‹Р№ С‚РѕРєРµРЅ РїРµСЂРµСЃС‚Р°С‘С‚ СЃРѕРІРїР°РґР°С‚СЊ СЃ РЅРѕРІС‹Рј С…СЌС€РµРј
        // Рё РјРіРЅРѕРІРµРЅРЅРѕ РїРµСЂРµСЃС‚Р°С‘С‚ СЂР°Р±РѕС‚Р°С‚СЊ, Р±РµР· РѕС‚РґРµР»СЊРЅРѕРіРѕ С€Р°РіР° РѕС‚Р·С‹РІР°.
        await client.query(`
      ALTER TABLE stream_users ADD COLUMN IF NOT EXISTS companion_token_hash VARCHAR(64);
      ALTER TABLE stream_users ADD COLUMN IF NOT EXISTS companion_token_created_at TIMESTAMP;
      ALTER TABLE stream_users ADD COLUMN IF NOT EXISTS companion_last_seen_at TIMESTAMP;
    `);
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_users_companion_token_hash
        ON stream_users(companion_token_hash) WHERE companion_token_hash IS NOT NULL;
    `);

        // РџРѕСЃР»РµРґРЅРµРµ РёР·РІРµСЃС‚РЅРѕРµ GSI-СЃРѕСЃС‚РѕСЏРЅРёРµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ, РїСЂРёСЃР»Р°РЅРЅРѕРµ companion.
        // РќР°РјРµСЂРµРЅРЅРѕ РћР”РќРђ СЃС‚СЂРѕРєР° РЅР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ (UNIQUE + upsert), Р° РЅРµ Р¶СѓСЂРЅР°Р»
        // РєР°Р¶РґРѕРіРѕ РѕР±РЅРѕРІР»РµРЅРёСЏ - Dota С€Р»С‘С‚ GSI-СЃРѕР±С‹С‚РёСЏ РґРѕ РЅРµСЃРєРѕР»СЊРєРёС… СЂР°Р· РІ
        // СЃРµРєСѓРЅРґСѓ, РёСЃС‚РѕСЂРёСЏ РІСЃРµС… payload'РѕРІ Р±С‹СЃС‚СЂРѕ СЂР°Р·РґСѓР»Р° Р±С‹ С‚Р°Р±Р»РёС†Сѓ Р±РµР·
        // РєР°РєРѕР№-Р»РёР±Рѕ РїРѕР»СЊР·С‹ РґР»СЏ С‚РµРєСѓС‰РµР№ Р·Р°РґР°С‡Рё (overlay РїРѕРєР°Р·С‹РІР°РµС‚ С‚РѕР»СЊРєРѕ
        // "РїРѕСЃР»РµРґРЅРµРµ РёР·РІРµСЃС‚РЅРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ"). payload С…СЂР°РЅРёС‚СЃСЏ С†РµР»РёРєРѕРј РєР°Рє JSONB
        // Р±РµР· СЃС‚СЂРѕРіРѕР№ СЃС…РµРјС‹ - СЃС‚СЂСѓРєС‚СѓСЂР° GSI-РїРѕР»РµР№ РЅРµ РґРѕРєСѓРјРµРЅС‚РёСЂРѕРІР°РЅР° Valve
        // С„РѕСЂРјР°Р»СЊРЅРѕ Рё РјРѕР¶РµС‚ РѕС‚Р»РёС‡Р°С‚СЊСЃСЏ РѕС‚ РјР°С‚С‡Р° Рє РјР°С‚С‡Сѓ.
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_companion_states (
        id SERIAL PRIMARY KEY,
        stream_user_id INTEGER UNIQUE NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        received_at TIMESTAMP NOT NULL,
        companion_version VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // РСЃС‚РѕСЂРёСЏ Р·Р°РІРµСЂС€С‘РЅРЅС‹С… РјР°С‚С‡РµР№, СЂР°СЃРїРѕР·РЅР°РЅРЅС‹С… РёР· GSI-РїРѕС‚РѕРєР° companion
        // (services/stream-match-service.ts) - РѕС‚РґРµР»СЊРЅРѕ РѕС‚ stream_match_events
        // (С‚РѕС‚ Р·Р°РїРѕР»РЅСЏРµС‚СЃСЏ OpenDota-СЃРёРЅРєРѕРј Рё С…СЂР°РЅРёС‚ С‚РѕР»СЊРєРѕ hero_id/is_win РґР»СЏ
        // СЃС‡С‘С‚С‡РёРєР° wins/losses). Р—РґРµСЃСЊ РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅРѕ С…СЂР°РЅРёРј K/D/A, РєРѕС‚РѕСЂС‹С…
        // OpenDota API РЅРµ РѕС‚РґР°С‘С‚ СЃСЂР°Р·Сѓ РїРѕСЃР»Рµ РјР°С‚С‡Р°, Р° GSI - РѕС‚РґР°С‘С‚ РЅРµРјРµРґР»РµРЅРЅРѕ
        // СЃ Р»РѕРєР°Р»СЊРЅРѕРіРѕ РєР»РёРµРЅС‚Р°. match_id - BIGINT, nullable: GSI РїСЂРёСЃС‹Р»Р°РµС‚
        // matchid РЅРµ РїСЂРё РєР°Р¶РґРѕРј СЃС‚Р°СЂС‚Рµ РјР°С‚С‡Р° РЅР°РґС‘Р¶РЅРѕ (0 - РґР»СЏ Р±РѕС‚РѕРІС‹С… Р»РѕР±Р±Рё,
        // РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚ РІ РЅРµРєРѕС‚РѕСЂС‹С… СЃРѕСЃС‚РѕСЏРЅРёСЏС…) - РІ СЌС‚РѕРј СЃР»СѓС‡Р°Рµ РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ
        // СЃРёРЅС‚РµС‚РёС‡РµСЃРєРёР№ match_key (СЃРј. СЃРµСЂРІРёСЃ) РІРјРµСЃС‚Рѕ match_id РґР»СЏ РґРµРґСѓРїР°.
        // result - СЃС‚СЂРѕРєР° 'win'/'loss', РІС‹С‡РёСЃР»СЏРµС‚СЃСЏ СЃРµСЂРІРёСЃРѕРј СЃСЂР°РІРЅРµРЅРёРµРј
        // player.team_name СЃ map.win_team - GSI РґСЂСѓРіРёС… РёСЃС…РѕРґРѕРІ РЅРµ РґР°С‘С‚.
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_matches (
        id SERIAL PRIMARY KEY,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        match_id BIGINT,
        match_key VARCHAR(128) NOT NULL,
        hero_id INTEGER NOT NULL CHECK (hero_id > 0),
        kills INTEGER NOT NULL CHECK (kills >= 0),
        deaths INTEGER NOT NULL CHECK (deaths >= 0),
        assists INTEGER NOT NULL CHECK (assists >= 0),
        result VARCHAR(4) NOT NULL CHECK (result IN ('win', 'loss')),
        started_at TIMESTAMP NOT NULL,
        ended_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // Р•РґРёРЅСЃС‚РІРµРЅРЅР°СЏ Р·Р°С‰РёС‚Р° РѕС‚ РґСѓР±Р»РµР№ РЅР° СѓСЂРѕРІРЅРµ Р‘Р”, Р° РЅРµ С‚РѕР»СЊРєРѕ in-memory
        // С‚СЂРµРєРµСЂР° (С‚РѕС‚ СЃР±СЂР°СЃС‹РІР°РµС‚СЃСЏ РїСЂРё СЂРµСЃС‚Р°СЂС‚Рµ РїСЂРѕС†РµСЃСЃР°, РєР°Рє Рё cooldown РІ
        // dota-sync-service.ts) - РїРѕРІС‚РѕСЂРЅС‹Р№ INSERT СЃ С‚РµРј Р¶Рµ match_key
        // (ON CONFLICT DO NOTHING РІ СЃРµСЂРІРёСЃРµ) РїСЂРѕСЃС‚Рѕ РЅРµ СЃРѕР·РґР°СЃС‚ РІС‚РѕСЂСѓСЋ СЃС‚СЂРѕРєСѓ.
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_matches_user_key
        ON stream_matches(stream_user_id, match_key);
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_matches_user_ended
        ON stream_matches(stream_user_id, ended_at DESC);
    `);

        // Р¦РµРїРѕС‡РєР° СЂРµР№С‚РёРЅРіР° Рё СЂСѓС‡РЅР°СЏ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєР° РјР°С‚С‡Р°. Р Р°РЅСЊС€Рµ GSI-С„РёРЅР°Р»РёР·Р°С†РёСЏ
        // (services/stream-match-service.ts) РїРёСЃР°Р»Р° С‚РѕР»СЊРєРѕ stream_matches, Р°
        // wins/losses/rating РЅР° stream_sessions РґРІРёРіР°Р» РўРћР›Р¬РљРћ РѕС‚РґРµР»СЊРЅС‹Р№
        // OpenDota-СЃРёРЅРє (services/dota-sync-service.ts) - РѕС‚СЃСЋРґР° Рё Р±Р°Рі "РјР°С‚С‡
        // Р·Р°РїРёСЃР°Р»СЃСЏ, Р° W/L РЅРµ РѕР±РЅРѕРІРёР»РёСЃСЊ". РўРµРїРµСЂСЊ GSI-С„РёРЅР°Р»РёР·Р°С†РёСЏ СЃР°РјР° РІРµРґС‘С‚
        // rating_before/rating_delta/rating_after Рё РїРёС€РµС‚ РёС… РІ РѕРґРЅРѕР№ С‚СЂР°РЅР·Р°РєС†РёРё
        // СЃ РѕР±РЅРѕРІР»РµРЅРёРµРј СЃРµСЃСЃРёРё (СЃРј. finalizeGsiMatch). stream_session_id - Рє
        // РєР°РєРѕР№ СЃРµСЃСЃРёРё РїСЂРёРЅР°РґР»РµР¶Р°Р» РјР°С‚С‡ РЅР° РјРѕРјРµРЅС‚ С„РёРЅР°Р»РёР·Р°С†РёРё: Р±РµР· РЅРµРіРѕ
        // РЅРµРІРѕР·РјРѕР¶РЅРѕ РєР°СЃРєР°РґРЅРѕ РїРµСЂРµСЃС‡РёС‚Р°С‚СЊ С†РµРїРѕС‡РєСѓ СЂРµР№С‚РёРЅРіР° РїСЂРё СЂСѓС‡РЅРѕР№ РїСЂР°РІРєРµ
        // Р±РѕР»РµРµ СЃС‚Р°СЂРѕРіРѕ РјР°С‚С‡Р° (services/stream-match-correction-service.ts).
        // Р”Р»СЏ СѓР¶Рµ СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёС… СЃС‚СЂРѕРє РЅРёС‡РµРіРѕ РЅРµ РїСЂРёРґСѓРјС‹РІР°РµРј: rating_* РѕСЃС‚Р°СЋС‚СЃСЏ
        // NULL, stream_session_id NULL (РєР°РєРѕР№ СЃРµСЃСЃРёРё РїСЂРёРЅР°РґР»РµР¶Р°Р» РјР°С‚С‡ -
        // РЅРµРёР·РІРµСЃС‚РЅРѕ), result_source = 'gsi' (СЌС‚Рѕ РµРґРёРЅСЃС‚РІРµРЅРЅС‹Р№ РёСЃС‚РѕС‡РЅРёРє,
        // РєРѕС‚РѕСЂС‹Р№ СЃСѓС‰РµСЃС‚РІРѕРІР°Р» РґРѕ РїРѕСЏРІР»РµРЅРёСЏ СЂСѓС‡РЅРѕР№ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєРё).
        await client.query(`
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS stream_session_id INTEGER REFERENCES stream_sessions(id) ON DELETE SET NULL;
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS rating_before INTEGER CHECK (rating_before IS NULL OR rating_before > 0);
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS rating_delta INTEGER;
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS rating_after INTEGER CHECK (rating_after IS NULL OR rating_after > 0);
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS result_source VARCHAR(10) NOT NULL DEFAULT 'gsi' CHECK (result_source IN ('gsi', 'manual'));
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS rating_source VARCHAR(10) CHECK (rating_source IS NULL OR rating_source IN ('default', 'manual'));
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMP;
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_matches_session
        ON stream_matches(stream_session_id, ended_at);
    `);

        // Ranked/Unranked (СЃРј. Р·Р°РґР°С‡Сѓ "improve overlay as daily-driver tool").
        // game_mode РЅР° stream_users - СЌС‚Рѕ РўР•РљРЈР©РђРЇ РЅР°СЃС‚СЂРѕР№РєР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ
        // ("С‡С‚Рѕ РїСЂРёРјРµРЅРёС‚СЃСЏ Рє СЃР»РµРґСѓСЋС‰РµРјСѓ РјР°С‚С‡Сѓ"), РЅРµ РїСЂРёРІСЏР·Р°РЅР° Рє РєРѕРЅРєСЂРµС‚РЅРѕР№
        // stream_session Рё РЅРµ СЃР±СЂР°СЃС‹РІР°РµС‚СЃСЏ "РќР°С‡Р°С‚СЊ РЅРѕРІС‹Р№ СЃС‚СЂРёРј"
        // (resetActiveSession С‚СЂРѕРіР°РµС‚ С‚РѕР»СЊРєРѕ stream_sessions). game_mode РЅР°
        // stream_matches - СЃРЅРёРјРѕРє СЌС‚РѕР№ РЅР°СЃС‚СЂРѕР№РєРё РќРђ РњРћРњР•РќРў С„РёРЅР°Р»РёР·Р°С†РёРё РјР°С‚С‡Р°
        // (services/stream-match-service.ts), С‡С‚РѕР±С‹ РїРѕСЃР»РµРґСѓСЋС‰Р°СЏ СЃРјРµРЅР°
        // РїРѕР»СЊР·РѕРІР°С‚РµР»РµРј СЂРµР¶РёРјР° РЅРµ РјРµРЅСЏР»Р° РѕС‚РѕР±СЂР°Р¶РµРЅРёРµ СѓР¶Рµ Р·Р°РїРёСЃР°РЅРЅС‹С… РјР°С‚С‡РµР№.
        // DEFAULT 'ranked' РЅР° ADD COLUMN РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ Рё Р±СЌРєС„РёР»Р»РёС‚ РІСЃРµ
        // СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ СЃС‚СЂРѕРєРё, Рё Р·Р°РґР°С‘С‚ РґРµС„РѕР»С‚ РґР»СЏ РЅРѕРІС‹С… - СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓРµС‚
        // С‚СЂРµР±РѕРІР°РЅРёСЋ "РІСЃРµ СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ РјР°С‚С‡Рё СЃС‡РёС‚Р°СЋС‚СЃСЏ ranked".
        await client.query(`
      ALTER TABLE stream_users ADD COLUMN IF NOT EXISTS game_mode VARCHAR(10) NOT NULL DEFAULT 'ranked'
        CHECK (game_mode IN ('ranked', 'unranked'));
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS game_mode VARCHAR(10) NOT NULL DEFAULT 'ranked'
        CHECK (game_mode IN ('ranked', 'unranked'));
    `);
        // Existing users keep their uninterrupted cabinet flow; only accounts
        // created after this additive migration start with onboarding pending.
        await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stream_users' AND column_name = 'onboarding_completed_at'
        ) THEN
          ALTER TABLE stream_users ADD COLUMN onboarding_completed_at TIMESTAMP;
          UPDATE stream_users SET onboarding_completed_at = created_at;
        END IF;
      END $$;
    `);

        // РўСЂРµС‚РёР№ РІР·Р°РёРјРѕРёСЃРєР»СЋС‡Р°СЋС‰РёР№ СЂРµР·СѓР»СЊС‚Р°С‚ РјР°С‚С‡Р° - ABANDON. result Р±С‹Р»
        // VARCHAR(4) (С…РІР°С‚Р°Р»Рѕ СЂРѕРІРЅРѕ РЅР° 'win'/'loss') - СЂР°СЃС€РёСЂСЏРµРј РєРѕР»РѕРЅРєСѓ Рё
        // РїРµСЂРµСЃРѕР±РёСЂР°РµРј CHECK, С‡С‚РѕР±С‹ РІР»РµР·Р»Рѕ 'abandon'. Р­С‚Рѕ С‚РѕР»СЊРєРѕ СЂСѓС‡РЅРѕР№ РІС‹Р±РѕСЂ
        // РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ (СЃРј. stream-match-correction-service.ts) - GSI-РїРѕС‚РѕРє
        // (stream-match-service.ts) РїРѕ-РїСЂРµР¶РЅРµРјСѓ РїРёС€РµС‚ РёСЃРєР»СЋС‡РёС‚РµР»СЊРЅРѕ 'win'/'loss'.
        await client.query(`
      ALTER TABLE stream_matches ALTER COLUMN result TYPE VARCHAR(10);
      ALTER TABLE stream_matches DROP CONSTRAINT IF EXISTS stream_matches_result_check;
      ALTER TABLE stream_matches ADD CONSTRAINT stream_matches_result_check
        CHECK (result IN ('win', 'loss', 'abandon'));
    `);

        // Р Р°СЃРєР»Р°РґРєР° РІРёРґР¶РµС‚РѕРІ РїСѓР±Р»РёС‡РЅРѕРіРѕ overlay (РїРѕР·РёС†РёСЏ/РјР°СЃС€С‚Р°Р±/РІРёРґРёРјРѕСЃС‚СЊ РЅР°
        // РІРёРґР¶РµС‚) - СЂРµРґР°РєС‚РёСЂСѓРµС‚СЃСЏ РЅР° /stream/overlay-editor, РѕС‚РґР°С‘С‚СЃСЏ РІРјРµСЃС‚Рµ СЃ
        // РѕСЃС‚Р°Р»СЊРЅС‹Рј overlay-payload'РѕРј (controllers/stream/overlay.ts), Р±РµР·
        // РѕС‚РґРµР»СЊРЅРѕРіРѕ РїРѕР»Р»РёРЅРіР° РїРѕРґ РЅРµС‘. РћРґРЅР° СЃС‚СЂРѕРєР° РЅР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ - PUT
        // С†РµР»РёРєРѕРј РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚ layout; РѕС‚СЃСѓС‚СЃС‚РІРёРµ СЃС‚СЂРѕРєРё - РІР°Р»РёРґРЅС‹Р№ РєРµР№СЃ
        // (РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РµС‰С‘ РЅРµ РѕС‚РєСЂС‹РІР°Р» СЂРµРґР°РєС‚РѕСЂ), backend РІ СЌС‚РѕРј СЃР»СѓС‡Р°Рµ
        // РѕС‚РґР°С‘С‚ СЃРµСЂРІРµСЂРЅСѓСЋ РєРѕРЅСЃС‚Р°РЅС‚Сѓ DEFAULT_OVERLAY_LAYOUT.
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_overlay_settings (
        id SERIAL PRIMARY KEY,
        stream_user_id INTEGER UNIQUE NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        layout_version INTEGER NOT NULL DEFAULT 1,
        layout JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // Р РµС„РµСЂРµРЅСЃ-СЃРєСЂРёРЅС€РѕС‚ HUD РґР»СЏ overlay-СЂРµРґР°РєС‚РѕСЂР° ("С„РѕРЅ РґР»СЏ РїСЂРёРјРµСЂРєРё",
        // СЃРј. use-reference-background.ts РЅР° С„СЂРѕРЅС‚РµРЅРґРµ) - СЂР°РЅСЊС€Рµ Р¶РёР» С‚РѕР»СЊРєРѕ РІ
        // IndexedDB Р±СЂР°СѓР·РµСЂР°, С‚РµРїРµСЂСЊ РЅР° backend. РќР°РјРµСЂРµРЅРЅРѕ РћРўР”Р•Р›Р¬РќРђРЇ С‚Р°Р±Р»РёС†Р°
        // РѕС‚ stream_overlay_settings, Р° РЅРµ РєРѕР»РѕРЅРєРё РІ РЅРµР№: РІРѕ-РїРµСЂРІС‹С…, СЃС‚СЂРѕРєР°
        // Р·РґРµСЃСЊ РјРѕР¶РµС‚ СЃСѓС‰РµСЃС‚РІРѕРІР°С‚СЊ Р±РµР· СЃС‚СЂРѕРєРё РІ stream_overlay_settings (Рё
        // РЅР°РѕР±РѕСЂРѕС‚ - С‚Р°Рј layout NOT NULL, Р·РґРµСЃСЊ РµРіРѕ РЅРµС‚ РІРѕРІСЃРµ), РІРѕ-РІС‚РѕСЂС‹С…
        // СЌС‚Рѕ РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅРѕ СЃС‚СЂР°С…СѓРµС‚ РѕС‚ СЃР»СѓС‡Р°Р№РЅРѕРіРѕ РїСЂРѕС‚Р°СЃРєРёРІР°РЅРёСЏ СЃРєСЂРёРЅС€РѕС‚Р° РІ
        // layout JSONB, РєРѕС‚РѕСЂС‹Р№ СЌС…РѕРј СѓС…РѕРґРёС‚ РІ РїСѓР±Р»РёС‡РЅС‹Р№ /overlay/:token
        // (controllers/stream/overlay.ts) - СЌС‚Р° С‚Р°Р±Р»РёС†Р° С‚РµРј РїСѓР±Р»РёС‡РЅС‹Рј
        // РєРѕРЅС‚СЂРѕР»Р»РµСЂРѕРј РЅРµ С‡РёС‚Р°РµС‚СЃСЏ РІРѕРѕР±С‰Рµ, С‚РѕР»СЊРєРѕ editor-СЂРѕСѓС‚Р°РјРё РїРѕРґ
        // authenticateStreamUser.
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_overlay_reference_backgrounds (
        id SERIAL PRIMARY KEY,
        stream_user_id INTEGER UNIQUE NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        opacity REAL NOT NULL DEFAULT 0.7,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // РЇРІРЅС‹Р№ Р¶РёР·РЅРµРЅРЅС‹Р№ С†РёРєР» РјР°С‚С‡Р° (СѓРєСЂРµРїР»РµРЅРёРµ GSI-РїР°Р№РїР»Р°Р№РЅР°: СЂРµРєРѕРЅРЅРµРєС‚ РЅРµ
        // РґРѕР»Р¶РµРЅ РїР»РѕРґРёС‚СЊ РґСѓР±Р»Рё, РЅРµРґРѕРїРёСЃР°РЅРЅС‹Р№ РјР°С‚С‡ РЅРµ РґРѕР»Р¶РµРЅ С‚РµСЂСЏС‚СЊСЃСЏ РїСЂРё
        // СЂРµСЃС‚Р°СЂС‚Рµ, Р° СЃРїРѕСЂРЅС‹Р№ СЂРµР·СѓР»СЊС‚Р°С‚ РЅРµ РґРѕР»Р¶РµРЅ РјРѕР»С‡Р° СЃС‡РёС‚Р°С‚СЊСЃСЏ win/loss).
        // Р Р°РЅСЊС€Рµ СЃС‚СЂРѕРєР° stream_matches СЃРѕР·РґР°РІР°Р»Р°СЃСЊ Р•Р”РРќРЎРўР’Р•РќРќР«Р™ СЂР°Р· - РІ
        // РјРѕРјРµРЅС‚ С„РёРЅР°Р»РёР·Р°С†РёРё (POST_GAME) - РїРѕСЌС‚РѕРјСѓ РЅРёС‡РµРіРѕ РЅРµ РїРµСЂРµР¶РёРІР°Р»Рѕ
        // СЂРµСЃС‚Р°СЂС‚ РїСЂРѕС†РµСЃСЃР° РґРѕ СЌС‚РѕРіРѕ РјРѕРјРµРЅС‚Р°. РўРµРїРµСЂСЊ СЃС‚СЂРѕРєР° СЃРѕР·РґР°С‘С‚СЃСЏ СѓР¶Рµ РїСЂРё
        // СЃС‚Р°СЂС‚Рµ РјР°С‚С‡Р° (in_progress), РїРѕСЌС‚РѕРјСѓ result/ended_at Р±РѕР»СЊС€Рµ РЅРµ
        // РіР°СЂР°РЅС‚РёСЂРѕРІР°РЅРЅРѕ РёР·РІРµСЃС‚РЅС‹ РЅР° INSERT - DROP NOT NULL Р±РµР·РѕРїР°СЃРµРЅ РґР»СЏ
        // РїРѕРІС‚РѕСЂРЅРѕРіРѕ Р·Р°РїСѓСЃРєР° Рё РЅРµ С‚СЂРµР±СѓРµС‚ РѕС‚РґРµР»СЊРЅРѕРіРѕ РёР·РјРµРЅРµРЅРёСЏ CHECK
        // (Postgres CHECK РїСЂРѕРїСѓСЃРєР°РµС‚ NULL СЃР°Рј РїРѕ СЃРµР±Рµ).
        await client.query(`
      ALTER TABLE stream_matches ALTER COLUMN result DROP NOT NULL;
      ALTER TABLE stream_matches ALTER COLUMN ended_at DROP NOT NULL;
    `);
        await client.query(`
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS state VARCHAR(20) NOT NULL DEFAULT 'finalized'
        CHECK (state IN ('in_progress', 'post_game_pending', 'finalized', 'needs_review', 'interrupted'));
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS is_ranked BOOLEAN;
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS is_party BOOLEAN;
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS mode_source VARCHAR(20);
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS outcome_source VARCHAR(20);
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS confidence VARCHAR(12) NOT NULL DEFAULT 'confirmed'
        CHECK (confidence IN ('confirmed', 'probable', 'uncertain'));
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS post_game_detected_at TIMESTAMP;
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP;
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS finalize_reason VARCHAR(40);
    `);
        // Р‘СЌРєС„РёР»Р» СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёС… СЃС‚СЂРѕРє (РІСЃРµ РѕРЅРё РѕС‚РЅРѕСЃСЏС‚СЃСЏ Рє СѓР¶Рµ С„РёРЅР°Р»РёР·РёСЂРѕРІР°РЅРЅС‹Рј
        // РґРѕ СЌС‚РѕР№ С„РёС‡Рё РјР°С‚С‡Р°Рј) - С‚РѕР»СЊРєРѕ С‚Р°Рј, РіРґРµ РєРѕР»РѕРЅРєР° РµС‰С‘ РЅРµ Р·Р°РїРѕР»РЅРµРЅР°, С‡С‚Рѕ
        // РґРµР»Р°РµС‚ Р±Р»РѕРє Р±РµР·РѕРїР°СЃРЅС‹Рј РґР»СЏ РїРѕРІС‚РѕСЂРЅРѕРіРѕ Р·Р°РїСѓСЃРєР°.
        await client.query(`
      UPDATE stream_matches SET is_ranked = (game_mode = 'ranked') WHERE is_ranked IS NULL;
      UPDATE stream_matches SET mode_source = 'account_setting' WHERE mode_source IS NULL;
      UPDATE stream_matches SET outcome_source = 'gsi_win_team' WHERE outcome_source IS NULL AND result_source = 'gsi';
      UPDATE stream_matches SET finalized_at = ended_at WHERE finalized_at IS NULL AND ended_at IS NOT NULL;
      UPDATE stream_matches SET finalize_reason = 'legacy_backfill' WHERE finalize_reason IS NULL;
    `);
        // match_id (Dota-РїСЂРёСЃРІРѕРµРЅРЅС‹Р№ РІРЅРµС€РЅРёР№ id РјР°С‚С‡Р°) СѓРЅРёРєР°Р»РµРЅ РЅР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ,
        // РєРѕРіРґР° РѕРЅ РёР·РІРµСЃС‚РµРЅ - СЂРµРєРѕРЅРЅРµРєС‚ Рє С‚РѕРјСѓ Р¶Рµ СЂРµР°Р»СЊРЅРѕРјСѓ РјР°С‚С‡Сѓ РЅРµ РґРѕР»Р¶РµРЅ
        // СЃРѕР·РґР°С‚СЊ РІС‚РѕСЂСѓСЋ СЃС‚СЂРѕРєСѓ, РґР°Р¶Рµ РµСЃР»Рё СЃРёРЅС‚РµС‚РёС‡РµСЃРєРёР№ match_key (СЃРј. СЃРµСЂРІРёСЃ)
        // СѓСЃРїРµР» СЂР°Р·РѕР№С‚РёСЃСЊ РёР·-Р·Р° СЂРµСЃС‚Р°СЂС‚Р° РїСЂРѕС†РµСЃСЃР° РјРµР¶РґСѓ РґРІСѓРјСЏ payload. РќРµ РјРѕР¶РµС‚
        // РєРѕРЅС„Р»РёРєС‚РѕРІР°С‚СЊ СЃ СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёРјРё РґР°РЅРЅС‹РјРё: match_key СѓР¶Рµ РІРєР»СЋС‡Р°РµС‚
        // match_id, РєРѕРіРґР° С‚РѕС‚ РёР·РІРµСЃС‚РµРЅ (`gsi:${matchId}`), Р° (stream_user_id,
        // match_key) Рё С‚Р°Рє СѓРЅРёРєР°Р»РµРЅ - Р·РЅР°С‡РёС‚ (stream_user_id, match_id) РґР»СЏ
        // РёР·РІРµСЃС‚РЅС‹С… match_id С‚РѕР¶Рµ СѓР¶Рµ Р±С‹Р»Р° СѓРЅРёРєР°Р»СЊРЅР°.
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_matches_user_external_match
        ON stream_matches(stream_user_id, match_id) WHERE match_id IS NOT NULL;
    `);
        // РќРµ Р±РѕР»РµРµ РѕРґРЅРѕРіРѕ "Р¶РёРІРѕРіРѕ" (РµС‰С‘ РЅРµ С„РёРЅР°Р»РёР·РёСЂРѕРІР°РЅРЅРѕРіРѕ Рё РЅРµ РѕС‚РїСЂР°РІР»РµРЅРЅРѕРіРѕ
        // РЅР° СЂСѓС‡РЅРѕР№ СЂР°Р·Р±РѕСЂ) РјР°С‚С‡Р° РЅР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ - РіР°СЂР°РЅС‚РёСЂСѓРµС‚,
        // С‡С‚Рѕ РїРµСЂРµС…РѕРґ РІ needs_review СЃС‚Р°СЂРѕРіРѕ РјР°С‚С‡Р° Рё СЃРѕР·РґР°РЅРёРµ РЅРѕРІРѕР№ СЃС‚СЂРѕРєРё
        // РІСЃРµРіРґР° РїСЂРѕРёСЃС…РѕРґСЏС‚ Р°С‚РѕРјР°СЂРЅРѕ РІ РѕРґРЅРѕР№ С‚СЂР°РЅР·Р°РєС†РёРё, Р° РЅРµ РѕСЃС‚Р°РІР»СЏСЋС‚ РґРІР°
        // РїР°СЂР°Р»Р»РµР»СЊРЅС‹С… "Р°РєС‚РёРІРЅС‹С…" РјР°С‚С‡Р°.
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_matches_one_active_per_user
        ON stream_matches(stream_user_id) WHERE state IN ('in_progress', 'post_game_pending', 'interrupted');
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_matches_user_state
        ON stream_matches(stream_user_id, state);
    `);

        // РўРѕС‡РµС‡РЅС‹Р№ Р°СѓРґРёС‚ lifecycle-РїР°Р№РїР»Р°Р№РЅР°: hero_id СЃР°Рј РїРѕ СЃРµР±Рµ РЅРµ Р±С‹Р»
        // РґРѕСЃС‚Р°С‚РѕС‡РЅС‹Рј РїСЂРёР·РЅР°РєРѕРј "С‚РѕРіРѕ Р¶Рµ РјР°С‚С‡Р°" РїСЂРё СЂРµРєРѕРЅРЅРµРєС‚Рµ Р±РµР· match_id
        // (РґРІР° СЂР°Р·РЅС‹С… РјР°С‚С‡Р° РїРѕРґСЂСЏРґ РЅР° РѕРґРЅРѕРј РіРµСЂРѕРµ РѕС€РёР±РѕС‡РЅРѕ СЃРєР»РµРёРІР°Р»РёСЃСЊ) -
        // player_team РґРѕР±Р°РІР»СЏРµС‚ РІС‚РѕСЂРѕР№ РЅРµР·Р°РІРёСЃРёРјС‹Р№ РїСЂРёР·РЅР°Рє (РєРѕРјР°РЅРґР° РЅРµ
        // РјРµРЅСЏРµС‚СЃСЏ РІ СЂР°РјРєР°С… РѕРґРЅРѕРіРѕ СЂРµР°Р»СЊРЅРѕРіРѕ РјР°С‚С‡Р°), Р° interrupted_at РґР°С‘С‚
        // РѕРіСЂР°РЅРёС‡РµРЅРЅРѕРµ СЂР°Р·СѓРјРЅРѕРµ РѕРєРЅРѕ РґР»СЏ СЂРµРєРѕРЅРЅРµРєС‚Р° РІРјРµСЃС‚Рѕ Р±РµСЃСЃСЂРѕС‡РЅРѕРіРѕ
        // "С‚РѕС‚ Р¶Рµ РіРµСЂРѕР№ = С‚РѕС‚ Р¶Рµ РјР°С‚С‡" (СЃРј. services/stream-match-service.ts,
        // sameMatch).
        await client.query(`
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS player_team VARCHAR(10);
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMP;
      ALTER TABLE stream_matches ADD COLUMN IF NOT EXISTS inventory JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

        // finalize_reason(40) СЂРµР°Р»СЊРЅРѕ РїРµСЂРµРїРѕР»РЅСЏР»СЃСЏ: СЃРѕСЃС‚Р°РІРЅС‹Рµ РїСЂРёС‡РёРЅС‹ РІРёРґР°
        // "<leave-reason>_single_observation" (СЃРј. handleLeftMatch РІ
        // services/stream-match-service.ts) РїСЂРµРІС‹С€Р°Р»Рё 40 СЃРёРјРІРѕР»РѕРІ, INSERT
        // РїР°РґР°Р» СЃ "value too long", Р° РѕС€РёР±РєР° С‚РёС…Рѕ РїСЂРѕРіР»Р°С‚С‹РІР°Р»Р°СЃСЊ РѕР±С‰РёРј
        // catch РІ processGsiPayloadForMatch - СЃРЅР°СЂСѓР¶Рё СЌС‚Рѕ РІС‹РіР»СЏРґРµР»Рѕ РєР°Рє
        // "РјР°С‚С‡ Р±РµР· РїСЂРѕС‚РёРІРѕСЂРµС‡РёР№ С‚Р°Рє Рё РЅРµ С„РёРЅР°Р»РёР·РёСЂРѕРІР°Р»СЃСЏ РїСЂРё СѓС…РѕРґРµ".
        await client.query(`
      ALTER TABLE stream_matches ALTER COLUMN finalize_reason TYPE VARCHAR(64);
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_queue_settings (
        stream_user_id INTEGER PRIMARY KEY REFERENCES stream_users(id) ON DELETE CASCADE,
        settings JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        await client.query(`
      CREATE TABLE IF NOT EXISTS stream_twitch_links (
        stream_user_id INTEGER PRIMARY KEY REFERENCES stream_users(id) ON DELETE CASCADE,
        twitch_user_id VARCHAR(64) NOT NULL UNIQUE,
        login VARCHAR(64) NOT NULL,
        display_name VARCHAR(128) NOT NULL,
        profile_image_url TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at TIMESTAMP,
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE stream_twitch_links ADD COLUMN IF NOT EXISTS access_token TEXT;
      ALTER TABLE stream_twitch_links ADD COLUMN IF NOT EXISTS refresh_token TEXT;
      ALTER TABLE stream_twitch_links ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;
      CREATE TABLE IF NOT EXISTS stream_twitch_connect_states (
        state VARCHAR(128) PRIMARY KEY,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stream_twitch_states_expires
        ON stream_twitch_connect_states(expires_at);
      CREATE TABLE IF NOT EXISTS stream_donation_alerts_links (
        stream_user_id INTEGER PRIMARY KEY REFERENCES stream_users(id) ON DELETE CASCADE,
        donation_alerts_user_id VARCHAR(64) NOT NULL UNIQUE,
        code VARCHAR(128) NOT NULL,
        display_name VARCHAR(128) NOT NULL,
        avatar_url TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_expires_at TIMESTAMP,
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS stream_donation_alerts_connect_states (
        state VARCHAR(128) PRIMARY KEY,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stream_donation_alerts_states_expires
        ON stream_donation_alerts_connect_states(expires_at);
      CREATE TABLE IF NOT EXISTS stream_donation_alerts_donations (
        donation_id BIGINT PRIMARY KEY,
        stream_user_id INTEGER NOT NULL REFERENCES stream_users(id) ON DELETE CASCADE,
        username VARCHAR(255) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        donated_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_stream_da_donations_user
        ON stream_donation_alerts_donations(stream_user_id);
    `);

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

