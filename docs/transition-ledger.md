# Transition ledger

Until the dedicated domain cutover, record every production backport here.

| Date | New repository change | Portfolio backport | Database/API compatibility |
| --- | --- | --- | --- |
| 2026-07-29 | Initial extraction baseline | Existing production source | Baseline contracts are equivalent |

Feature development in the portfolio copy is frozen after the initial public
commit. Urgent production fixes start here and are manually backported. Any
database migration or API response change must be compatible with both copies
and recorded before deployment.
