/**
 * `report_progress` meta tool, per harvest.md §9.6 (lines 1648–1669).
 *
 * Surfaces a single timestamped progress line on the user's stdout. Pure
 * side-effect; the Agent's turn flow is unaffected.
 *
 * Spec error model (§9.2 / §9.6 line 1669): only `schema_violation`. We
 * reformat Zod parse failures into the §9.2 envelope `{ error, message,
 * suggest, details? }` and never throw for spec errors.
 *
 * Output line format. The spec says only "timestamped 한 줄". We render
 * `[<HH:MM:SS>] <message>\n` — local-time, second precision. The full ISO
 * timestamp is returned as `shown_at` for callers that need a real instant.
 *
 * `stdout` is injectable (defaults to `process.stdout`); tests pass a memory
 * stream. We deliberately avoid `console.log`, which can wrap extra
 * formatting around `process.stdout.write` in some environments.
 */

import { z } from "zod";

import { nowIso as defaultNowIso } from "../../core/time.js";

// -----------------------------------------------------------------------------
// Schema + types
// -----------------------------------------------------------------------------

export const reportProgressInputSchema = z.object({
  message: z.string().min(1).max(200),
});

export type ReportProgressInput = z.infer<typeof reportProgressInputSchema>;

export interface ReportProgressOutput {
  acknowledged: true;
  shown_at: string;
}

/** §9.2 error envelope; `report_progress` only ever emits `schema_violation`. */
export interface ReportProgressErrorOutput {
  error: "schema_violation";
  message: string;
  suggest: string;
  details?: unknown;
}

export interface ReportProgressDeps {
  /** Defaults to `process.stdout`. Inject for tests. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to {@link defaultNowIso}. Inject for tests. */
  nowIso?: () => string;
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

/** Local-time `HH:MM:SS`, used only for the stdout prefix. */
function formatHms(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Validate, write a timestamped line, and return the structured ack. Returns
 * the §9.2 error envelope on schema violation (does not throw); genuine I/O
 * failures from the stream still propagate as exceptions.
 */
export async function reportProgress(
  input: unknown,
  deps: ReportProgressDeps = {},
): Promise<ReportProgressOutput | ReportProgressErrorOutput> {
  const parsed = reportProgressInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: "schema_violation",
      message: "report_progress 입력 스키마 위반",
      suggest: "message는 1..200자 사이의 문자열이어야 합니다.",
      details: parsed.error.issues,
    };
  }

  const stdout = deps.stdout ?? process.stdout;
  const nowIso = deps.nowIso ?? defaultNowIso;
  const shownAt = nowIso();
  const hms = formatHms(new Date());
  stdout.write(`[${hms}] ${parsed.data.message}\n`);

  return { acknowledged: true, shown_at: shownAt };
}
