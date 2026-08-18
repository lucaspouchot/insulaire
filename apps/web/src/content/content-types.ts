/**
 * TypeScript mirror of the authored content schema.
 *
 * Kept in step with `crates/world/src/definition.rs` and
 * `crates/world/src/tileset.rs`; `docs/content-format.md` is the shared
 * specification. These types describe files on disk — they are not runtime
 * state, and the editor never mutates a definition in place.
 */

/** `[col, row]` in odd-r offset coordinates. */
export type OffsetPair = [number, number];

export const WORLD_SCHEMA_VERSION = 1;
export const TILE_SET_SCHEMA_VERSION = 1;

export interface TileVisual {
  visualId: string;
  fallbackColor: string;
  hints?: Record<string, string>;
}

export interface TileDefinition {
  id: string;
  name?: string;
  terrain: string;
  /** `0` means impassable. */
  movementCost: number;
  tags?: string[];
  visual: TileVisual;
}

export interface TileSetDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  tiles: TileDefinition[];
}

/** How the renderer projects a world; mirrors the engine's `ProjectionMode`. */
export type ProjectionMode = 'topDown' | 'isometric';

/** Authored elevation is packed as one signed byte per cell for the renderer. */
export const MIN_ELEVATION = -128;
export const MAX_ELEVATION = 127;

/** A cell whose tile differs from {@link WorldDefinition.defaultTile}. */
export interface PlacedTile {
  at: OffsetPair;
  tile: string;
  /** Whole steps of relief, `MIN_ELEVATION`..`MAX_ELEVATION`. Omitted when `0`. */
  elevation?: number;
  tags?: string[];
}

export interface EntityDefinition {
  id: string;
  templateId: string;
  at: OffsetPair;
  tags?: string[];
  properties?: Record<string, unknown>;
}

export interface LocationDefinition {
  id: string;
  at: OffsetPair;
  name?: string;
  tags?: string[];
}

/** What makes a {@link MapLink} fire. Only `enter` is implemented. */
export type LinkTrigger = 'enter' | 'interact';

/**
 * A cell that sends the player to another map.
 *
 * The only cross-file reference in the world schema: `targetWorld` names a
 * world that lives in another file, so the editor can only check it once the
 * whole project is loaded (`docs/adr/ADR-0017-map-links.md`).
 */
export interface MapLink {
  id: string;
  at: OffsetPair;
  targetWorld: string;
  targetAt: OffsetPair;
  /** Omitted when `enter`, which is the default. */
  trigger?: LinkTrigger;
  name?: string;
  tags?: string[];
}

export interface WorldMetadata {
  author?: string;
  description?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface WorldDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  /**
   * Id of the {@link ZoneDefinition} this map belongs to.
   *
   * Every map has a zone; absent or empty names the project's default one
   * rather than *no* zone. A zone id only resolves against the project that
   * declares it, so the Rust validator is what checks it
   * (`docs/adr/ADR-0021-map-zones.md`).
   */
  zone?: string;
  width: number;
  height: number;
  orientation?: 'pointy' | 'flat';
  /** Presentation only; defaults to `topDown` when absent. */
  projection?: ProjectionMode;
  tileSetId: string;
  defaultTile: string;
  tiles?: PlacedTile[];
  entities?: EntityDefinition[];
  locations?: LocationDefinition[];
  links?: MapLink[];
  metadata?: WorldMetadata;
}

export const PROJECT_SCHEMA_VERSION = 1;

/** One content file a project ships, by id and path under the content root. */
export interface ContentRef {
  id: string;
  path: string;
}

/**
 * The manifest of one game: which content files it is made of, and where a
 * session starts.
 *
 * It is what lets a client build boot with no editor and no backend — it reads
 * this file and loads exactly what it lists
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 */
/**
 * Id of the zone a project falls back on when it declares none.
 *
 * Mirrors `insulaire_world::DEFAULT_ZONE_ID`.
 */
export const DEFAULT_ZONE_ID = 'default';

/**
 * A group of maps that belong together.
 *
 * The unit of simulated scope: a tick advances the maps of one zone, not only
 * the map the player stands on (`docs/adr/ADR-0021-map-zones.md`). Zones are
 * declared by the project, and every map names exactly one.
 */
export interface ZoneDefinition {
  id: string;
  name?: string;
}

/**
 * One language the game is available in, and the files that translate it.
 *
 * Each file's {@link ContentRef.id} is its **namespace**: `locales/fr/menu.json`
 * registered as `menu` provides the keys under `menu.`
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 */
export interface LanguageDefinition {
  id: string;
  /** Name shown in the language picker, in that language. */
  name?: string;
  files?: ContentRef[];
}

/** The languages a project ships, and which one stands in for the others. */
export interface LocalesDefinition {
  /** Id of the fallback language. Absent means the first declared. */
  default?: string;
  languages?: LanguageDefinition[];
}

export interface ProjectDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  startWorld: string;
  /** Zones, in author order. The first is the default; absent means one implicit
   * {@link DEFAULT_ZONE_ID} zone. */
  zones?: ZoneDefinition[];
  tileSets: ContentRef[];
  worlds: ContentRef[];
  /** The title screen a client opens on. Absent means it starts on a map. */
  titleScreen?: ContentRef;
  /** The settings this game offers. The application's own are not content. */
  settings?: ContentRef;
  /** Languages and their locale files. Absent means the application's own. */
  locales?: LocalesDefinition;
}

export const TITLE_SCREEN_SCHEMA_VERSION = 1;

/**
 * What a title screen button does.
 *
 * A closed set: an action is something the application implements, so a new one
 * is a code change, not a content field
 * (`docs/adr/ADR-0024-authored-title-screen.md`).
 */
export type TitleAction = 'newGame' | 'continue' | 'settings' | 'credits' | 'quit';

export interface TitleButton {
  action: TitleAction;
  /** Key of its label, resolved against the language in use. */
  labelKey: string;
  /** Authored out of the menu without deleting it. */
  hidden?: boolean;
}

export type BackgroundFit = 'cover' | 'contain' | 'tile';

export interface TitleBackground {
  /** Path under the content root. Empty means a plain background. */
  image: string;
  fit: BackgroundFit;
  /** CSS colour over the image, and used alone when there is none. */
  tint: string;
}

export interface TitleLogo {
  image: string;
  /** Width as a percentage of the screen, `1..=100`. */
  maxWidthPercent: number;
}

export interface TitleSplash {
  /** Path under the content root. Empty shows the title alone. */
  image: string;
  durationMs: number;
  skippable: boolean;
}

export interface TitleMusic {
  track: string;
  loops: boolean;
  /** Relative to the music volume setting, `0..=1`. */
  gain: number;
  fadeInMs: number;
}

export interface TitleTheme {
  accent: string;
  text: string;
  panel: string;
  /** CSS font family for the title. */
  font: string;
}

export type TitleLayout = 'left' | 'center' | 'right';

/**
 * The authored title screen: what a delivered client opens on.
 *
 * Mirrors `crates/world/src/title_screen.rs`. Every field the engine fills a
 * default for is required here, because this type describes what comes *out*
 * of `titleScreen()` — the file itself may leave most of it out.
 */
export interface TitleScreenDefinition {
  id: string;
  schemaVersion: number;
  titleKey: string;
  subtitleKey: string;
  background: TitleBackground;
  logo: TitleLogo | null;
  splash: TitleSplash | null;
  music: TitleMusic | null;
  theme: TitleTheme;
  layout: TitleLayout;
  buttons: TitleButton[];
}

export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * How a setting is presented, and therefore what values it accepts.
 *
 * Mirrors `crates/world/src/settings.rs`. The **same** vocabulary describes the
 * application's own settings and the game's, so one component renders both
 * (`docs/adr/ADR-0025-settings.md`).
 */
export type ControlKind =
  | 'toggle'
  | 'checkbox'
  | 'select'
  | 'multiSelect'
  | 'slider'
  | 'number'
  | 'text'
  | 'color';

/** When a setting may be changed. */
export type SettingScope = 'session' | 'newGame';

/** A value a setting can hold. */
export type SettingValue = boolean | number | string | string[];

export interface ControlOption {
  value: string;
  labelKey: string;
}

/** Shows a field only when another one holds a given value. */
export interface ShowIf {
  field: string;
  equals: SettingValue;
}

export interface ControlDefinition {
  /** Stable id; the key its value is stored under. */
  id: string;
  labelKey: string;
  helpKey?: string;
  control: ControlKind;
  default: SettingValue;
  options?: ControlOption[];
  min?: number | null;
  max?: number | null;
  step?: number | null;
  /** Shown next to the value, e.g. `%`. Displayed as written. */
  unit?: string;
  scope?: SettingScope;
  showIf?: ShowIf | null;
}

export interface SettingsGroup {
  id: string;
  labelKey: string;
  fields: ControlDefinition[];
}

export interface SettingsSection {
  id: string;
  labelKey: string;
  groups: SettingsGroup[];
}

/** The settings a project declares. */
export interface SettingsDefinition {
  id: string;
  schemaVersion: number;
  sections: SettingsSection[];
}

/** Values by field id, as stored and as `createGame` receives them. */
export type SettingsValues = Record<string, SettingValue>;
