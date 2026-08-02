// Turns the field catalog into a short, pre-digested "what can we build"
// report - the brief's ask #3 ("Отчёт что можно добавить"). This is a
// heuristic, name-based rule engine, not a semantic understanding of GSI: it
// only says "this path showed up, here's a plausible feature it enables" or
// "this path/keyword never showed up this session". Every rendered output
// carries a disclaimer to that effect - see `render_markdown`.

use std::collections::HashSet;

use serde::Serialize;

use super::catalog::FieldInfo;

struct FeatureCandidate {
    path: &'static str,
    description: &'static str,
    /// If the field never showed up this session, is that itself worth a
    /// line in the report (vs. just quietly not being "confirmed")?
    notable_if_absent: bool,
}

const FEATURE_CANDIDATES: &[FeatureCandidate] = &[
    FeatureCandidate {
        path: "map.matchid",
        description: "можно автоматически связывать матчи (история, дедупликация)",
        notable_if_absent: true,
    },
    FeatureCandidate {
        path: "map.win_team",
        description: "можно определять победителя матча",
        notable_if_absent: true,
    },
    FeatureCandidate {
        path: "map.game_state",
        description: "можно строить состояние матча (меню/пик/игра/результат)",
        notable_if_absent: false,
    },
    FeatureCandidate { path: "map.paused", description: "можно определять паузу", notable_if_absent: false },
    FeatureCandidate { path: "map.game_mode", description: "можно определять режим игры", notable_if_absent: false },
    FeatureCandidate {
        path: "map.game_time",
        description: "можно строить таймлайн матча по игровому времени",
        notable_if_absent: false,
    },
    FeatureCandidate { path: "map.clock_time", description: "можно показывать игровые часы", notable_if_absent: false },
    FeatureCandidate { path: "map.daytime", description: "можно показывать день/ночь", notable_if_absent: false },
    FeatureCandidate {
        path: "events[].event_type",
        description: "можно отслеживать события матча, включая roshan_killed и aegis_picked_up; массив скользящий, события требуют дедупликации по содержимому",
        notable_if_absent: true,
    },
    FeatureCandidate { path: "hero.id", description: "можно показывать выбранного героя", notable_if_absent: false },
    FeatureCandidate {
        path: "hero.name",
        description: "можно показывать выбранного героя по имени",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "hero.alive",
        description: "можно отслеживать смерть/возрождение героя",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "hero.respawn_seconds",
        description: "можно показывать таймер возрождения",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "hero.buyback_cooldown",
        description: "можно определить байбек локального героя; ненулевое значение — игровое время доступности следующего байбека, а не оставшиеся секунды",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "hero.buyback_cost",
        description: "можно показывать текущую стоимость байбека локального героя",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "player.activity",
        description: "можно определять фазу игрока (playing/menu/...)",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "player.team_name",
        description: "можно показывать команду игрока (Radiant/Dire)",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "player.kills",
        description: "можно показывать K/D/A в реальном времени",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "player.deaths",
        description: "можно показывать K/D/A в реальном времени",
        notable_if_absent: false,
    },
    FeatureCandidate {
        path: "player.assists",
        description: "можно показывать K/D/A в реальном времени",
        notable_if_absent: false,
    },
    FeatureCandidate { path: "player.gold", description: "можно показывать золото игрока", notable_if_absent: false },
    FeatureCandidate {
        path: "player.last_hits",
        description: "можно показывать CS (last hits)",
        notable_if_absent: false,
    },
    FeatureCandidate { path: "player.net_worth", description: "можно показывать net worth", notable_if_absent: false },
    FeatureCandidate {
        path: "player.steamid",
        description: "можно связывать GSI-сессию со Steam-аккаунтом игрока",
        notable_if_absent: true,
    },
    FeatureCandidate {
        path: "provider.appid",
        description: "можно проверять, что это действительно Dota 2 (защита от левых GSI-клиентов)",
        notable_if_absent: false,
    },
];

/// Concepts the brief specifically flags as interesting for match-lifecycle
/// detection (see original diagnostics brief, section 5). A "found" result
/// only means some catalog PATH's name contains the keyword - it is not a
/// claim that the concept works or means what it sounds like.
const LIFECYCLE_KEYWORDS: &[&str] = &["abandon", "disconnect", "reconnect", "safe_to_leave"];
const MAX_OTHER_UNUSED_FIELDS: usize = 30;

#[derive(Debug, Clone, Serialize)]
pub struct ConfirmedCandidate {
    pub path: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NotableAbsence {
    pub path: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifecycleSignalResult {
    pub keyword: String,
    pub found: bool,
    pub matching_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalysisSummary {
    pub session_id: String,
    pub generated_at: String,
    pub confirmed_feature_candidates: Vec<ConfirmedCandidate>,
    pub notable_absences: Vec<NotableAbsence>,
    pub lifecycle_signal_scan: Vec<LifecycleSignalResult>,
    /// known_to_companion && !currently_used fields not already covered by
    /// FEATURE_CANDIDATES above - capped so the report stays readable.
    pub other_unused_known_fields: Vec<String>,
}

pub fn analyze(fields: &[&FieldInfo], session_id: &str, generated_at: &str) -> AnalysisSummary {
    let path_set: HashSet<&str> = fields.iter().map(|f| f.path.as_str()).collect();
    let mut covered_paths: HashSet<&str> = HashSet::new();

    let mut confirmed_feature_candidates = Vec::new();
    let mut notable_absences = Vec::new();
    for candidate in FEATURE_CANDIDATES {
        covered_paths.insert(candidate.path);
        if path_set.contains(candidate.path) {
            confirmed_feature_candidates.push(ConfirmedCandidate {
                path: candidate.path.to_string(),
                description: candidate.description.to_string(),
            });
        } else if candidate.notable_if_absent {
            notable_absences.push(NotableAbsence {
                path: candidate.path.to_string(),
                description: candidate.description.to_string(),
            });
        }
    }

    let lifecycle_signal_scan = LIFECYCLE_KEYWORDS
        .iter()
        .map(|keyword| {
            let matching_paths: Vec<String> = fields
                .iter()
                .filter(|f| f.path.to_ascii_lowercase().contains(keyword))
                .map(|f| f.path.clone())
                .collect();
            LifecycleSignalResult { keyword: keyword.to_string(), found: !matching_paths.is_empty(), matching_paths }
        })
        .collect();

    let mut other_unused_known_fields: Vec<String> = fields
        .iter()
        .filter(|f| f.known_to_companion && !f.currently_used && !covered_paths.contains(f.path.as_str()))
        .map(|f| f.path.clone())
        .collect();
    other_unused_known_fields.sort();
    other_unused_known_fields.truncate(MAX_OTHER_UNUSED_FIELDS);

    AnalysisSummary {
        session_id: session_id.to_string(),
        generated_at: generated_at.to_string(),
        confirmed_feature_candidates,
        notable_absences,
        lifecycle_signal_scan,
        other_unused_known_fields,
    }
}

pub fn render_markdown(summary: &AnalysisSummary) -> String {
    let mut out = String::new();
    out.push_str("# Possible features — GSI diagnostics analysis\n\n");
    out.push_str(&format!("Session: {}\n", summary.session_id));
    out.push_str(&format!("Generated: {}\n\n", summary.generated_at));

    out.push_str("## Confirmed candidates (field present this session)\n\n");
    if summary.confirmed_feature_candidates.is_empty() {
        out.push_str("_None of the curated candidate fields showed up this session._\n\n");
    } else {
        for c in &summary.confirmed_feature_candidates {
            out.push_str(&format!("- ✓ `{}` → {}\n", c.path, c.description));
        }
        out.push('\n');
    }

    out.push_str("## Notable absences\n\n");
    if summary.notable_absences.is_empty() {
        out.push_str("_Nothing on the notable-if-absent watch list was missing._\n\n");
    } else {
        for a in &summary.notable_absences {
            out.push_str(&format!("- ? `{}` отсутствует — {}\n", a.path, a.description));
        }
        out.push('\n');
    }

    out.push_str("## Lifecycle-signal keyword scan\n\n");
    for r in &summary.lifecycle_signal_scan {
        if r.found {
            out.push_str(&format!("- ✓ `{}` — совпадения: {}\n", r.keyword, r.matching_paths.join(", ")));
        } else {
            out.push_str(&format!("- ? нет полей, содержащих `{}` — признаков этого в GSI за эту сессию не обнаружено\n", r.keyword));
        }
    }
    out.push('\n');

    out.push_str("## Other unused-but-known fields worth reviewing manually\n\n");
    if summary.other_unused_known_fields.is_empty() {
        out.push_str("_None beyond the curated candidates above._\n\n");
    } else {
        for path in &summary.other_unused_known_fields {
            out.push_str(&format!("- `{path}`\n"));
        }
        out.push('\n');
    }

    out.push_str("---\n\n");
    out.push_str(
        "This is a heuristic, rule-based summary generated from field NAMES observed\n\
         this session — it does not read Valve's GSI documentation and does not\n\
         guarantee a field means what its name suggests. Absence of a field this\n\
         session does not prove Dota never sends it (menu-only fields, different\n\
         game modes, spectator vs player perspective, etc. may simply not have come\n\
         up). Verify against field-catalog.json's sample values before building\n\
         anything on this.\n",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::catalog::FieldCatalog;
    use serde_json::json;

    fn catalog_from(payload: serde_json::Value) -> FieldCatalog {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&payload, None);
        catalog
    }

    #[test]
    fn confirms_candidates_present_in_the_catalog() {
        let catalog = catalog_from(json!({
            "map": { "matchid": "1", "win_team": "radiant", "game_state": "POST_GAME" },
            "hero": { "id": 1, "buyback_cooldown": 2666, "buyback_cost": 852 },
            "events": [
                { "event_type": "roshan_killed", "game_time": 1684 },
                { "event_type": "aegis_picked_up", "game_time": 1684 }
            ]
        }));
        let fields: Vec<&FieldInfo> = catalog.fields.values().collect();
        let summary = analyze(&fields, "s1", "2026-07-25T00:00:00+07:00");

        let paths: Vec<&str> = summary.confirmed_feature_candidates.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"map.matchid"));
        assert!(paths.contains(&"map.win_team"));
        assert!(paths.contains(&"hero.id"));
        assert!(paths.contains(&"events[].event_type"));
        assert!(paths.contains(&"hero.buyback_cooldown"));
        assert!(paths.contains(&"hero.buyback_cost"));
        assert!(!summary.notable_absences.iter().any(|a| a.path == "map.roshan_state"));
    }

    #[test]
    fn flags_notable_absences_but_not_ordinary_ones() {
        // map.matchid/win_team/player.steamid are notable_if_absent; map.paused isn't.
        let catalog = catalog_from(json!({ "hero": { "id": 1 } }));
        let fields: Vec<&FieldInfo> = catalog.fields.values().collect();
        let summary = analyze(&fields, "s1", "now");

        let absent_paths: Vec<&str> = summary.notable_absences.iter().map(|a| a.path.as_str()).collect();
        assert!(absent_paths.contains(&"map.matchid"));
        assert!(absent_paths.contains(&"player.steamid"));
        assert!(absent_paths.contains(&"events[].event_type"));
        assert!(!absent_paths.contains(&"map.roshan_state"));
        assert!(!absent_paths.contains(&"map.paused"), "map.paused isn't notable_if_absent");
    }

    #[test]
    fn lifecycle_scan_reports_unfound_keywords_without_false_conclusions() {
        let catalog = catalog_from(json!({ "map": { "game_state": "MENU" } }));
        let fields: Vec<&FieldInfo> = catalog.fields.values().collect();
        let summary = analyze(&fields, "s1", "now");

        let abandon = summary.lifecycle_signal_scan.iter().find(|r| r.keyword == "abandon").unwrap();
        assert!(!abandon.found);
        assert!(abandon.matching_paths.is_empty());
    }

    #[test]
    fn lifecycle_scan_finds_a_matching_path_when_present() {
        let catalog = catalog_from(json!({ "player": { "player_disconnect_flag": true } }));
        let fields: Vec<&FieldInfo> = catalog.fields.values().collect();
        let summary = analyze(&fields, "s1", "now");

        let disconnect = summary.lifecycle_signal_scan.iter().find(|r| r.keyword == "disconnect").unwrap();
        assert!(disconnect.found);
        assert!(disconnect.matching_paths.iter().any(|p| p.contains("player_disconnect_flag")));
    }

    #[test]
    fn other_unused_known_fields_excludes_curated_candidates() {
        let catalog = catalog_from(json!({ "player": { "kills": 1, "some_uncurated_field": true } }));
        let fields: Vec<&FieldInfo> = catalog.fields.values().collect();
        let summary = analyze(&fields, "s1", "now");

        // player.kills is a curated candidate (confirmed above), must not
        // also show up in the generic "other" bucket.
        assert!(!summary.other_unused_known_fields.contains(&"player.kills".to_string()));
        assert!(summary.other_unused_known_fields.contains(&"player.some_uncurated_field".to_string()));
    }

    #[test]
    fn markdown_render_includes_disclaimer_and_does_not_panic_on_empty_summary() {
        let summary = AnalysisSummary {
            session_id: "s1".into(),
            generated_at: "now".into(),
            confirmed_feature_candidates: vec![],
            notable_absences: vec![],
            lifecycle_signal_scan: vec![],
            other_unused_known_fields: vec![],
        };
        let md = render_markdown(&summary);
        assert!(md.contains("heuristic"));
        assert!(md.contains("s1"));
    }
}
