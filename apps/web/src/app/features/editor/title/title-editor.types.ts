/**
 * The shapes the title screen editor works with.
 *
 * Re-exported rather than imported all over the component so the editor names
 * one module, and so the `null`-vs-`undefined` question has exactly one answer:
 * the engine emits `null` for an absent block, and the editor keeps it that way
 * so a saved file round-trips through `titleScreen()` unchanged.
 */

export type {
  TitleAction,
  TitleButton,
  TitleLayout,
  TitleScreenDefinition,
} from '../../../../content/generated/title-screen';

/** The part of a `ValidationReport` this screen displays. */
export interface ValidationReportLike {
  readonly valid: boolean;
  readonly issues: readonly {
    readonly code: string;
    readonly severity: string;
    readonly path: string;
    readonly message: string;
  }[];
}
