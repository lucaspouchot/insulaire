/**
 * What a bag of authored values is keyed by.
 *
 * `SettingValue` itself is generated (`generated/settings.ts`), declared in
 * `crates/world/src/settings.rs` so the narrowing the editor relies on is
 * Rust's statement rather than TypeScript's guess. These two aliases are the
 * shapes it is carried in, which no Rust item names: Rust holds them as
 * `BTreeMap<String, Value>` and the map, not the alias, is what crosses.
 */
import type { SettingValue } from './generated/settings';

/** Settings values, keyed by {@link ControlDefinition.id}. */
export type SettingsValues = Record<string, SettingValue>;

/** Character customisation values, keyed by parameter id. */
export type CharacterValues = Record<string, SettingValue>;
