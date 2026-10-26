# ADR-003: Unsettled A7 rules are configuration, effective-dated

- Date: 2026-10-26 · Status: accepted
- Context: A7 draft 0.1 has decisions D1–D12 and review conflicts C1–C7 not yet signed off.
- Decision: Every unsettled rule is a field in `FlagRulesConfig` with the A7 text as the default. The database stores rules effective-dated per site (`flag_rules`), so past results keep the rules that applied (plan 11.5).
- Consequences: Building is not blocked and no choice is hidden in code. Tests cover each option.
