# ADR 0005 — UTF-8 discipline on a CP936 host

## Status
Accepted, 2026-01.

## Context
The reference machine's console reports two encodings at once: `chcp` prints **936** (GBK), while
`[Console]::OutputEncoding` prints `utf-8`. Text crossing a boundary that trusts the wrong answer is
written or read as GBK, silently — a file that looks broken in one tool looks fine in another. This is
not hypothetical: a sample file shipped inside `reference/` in this very checkout demonstrates it, with
`reference/dalabengba-mv/复现全流程.md` valid UTF-8 on disk (bytes verified) yet decoding through the
CP936 path as `# 銆婅揪鎷夊穿鍚с€嬬焊鑹?RPG 浠ｇ爜 MV 鈥斺€?瀹屽叏澶嶇幇鎵嬪唽`. Two more from that
session: `certutil`'s localized success line arrives as mojibake in a console that believes it is UTF-8,
and `python -c` printing that line dies with `UnicodeEncodeError: 'gbk' codec can't encode '\u20ac'`
unless UTF-8 mode is forced. The framework's target work is CJK music video.

## Decision
UTF-8 is specified **explicitly on every handle**, never inherited ([SPEC](../SPEC.md) P4):

- Every file handle in Python and Node specifies UTF-8; `errors="replace"` is forbidden, because a
  replacement character destroys the evidence of the bug.
- The CLI sets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` when it spawns Python, and generated Windows
  helpers run `chcp 65001` before reading or writing text.
- Temp paths handed to external processes (browser profiles, ffmpeg intermediates, frame sequences) are
  **ASCII-only** (`CVPW_TMP`): a non-ASCII path can break a profile directory or mangle an ffmpeg argument.
- `cvpw lint` scans for U+FFFD and for bytes that are not valid UTF-8; stage boundaries also enforce no
  BOM and LF endings (A1, [QA](../QA.md) §2 `encoding.utf8`).
- Verification is by **bytes**, never by reading: `certutil -dump` or an explicit byte check. Repair
  means fixing the handle that wrote the file and regenerating the artifact, never re-typing the text.

## Consequences
**Positive**
- Text artifacts are portable and CJK content is fully supported; encoding damage fails at a stage
  boundary with a byte-level offender instead of as a review complaint.

**Negative**
- Every handle carries an explicit encoding; the platform default is never a shortcut, and ASCII-only
  scratch space constrains where a project may live (a CJK project path is fine, its temp root is not).
- Tools that emit the ANSI code page still produce mojibake in captured logs, so localized stderr MUST
  NOT be parsed: judge tools by exit code and JSON output ([SPEC](../SPEC.md) P1).

**Neutral, and needs monitoring**
- Every new child process is a chance to inherit a handle; `cvpw env --json` reporting the temp root and
  the Python encoding flags is the standing check.
- The invalid-UTF-8 scan applies to text artifacts only (binary artifacts MUST be excluded, or the check
  becomes noise); editors and terminals keep their own encoding guesses, so the byte check is authority.

## Alternatives considered
- **Rely on the platform default.** Rejected: it already produced mojibake in this checkout, and it fails
  silently — a file written as GBK is valid bytes, just not the intended ones.
- **ASCII-only content.** Rejected: unacceptable for CJK projects, a primary target, and paths and console
  output would keep the hazard alive regardless of content.
- **A pre-commit fixer that rewrites suspicious text.** Rejected: it rewrites files that were never
  broken, cannot know the correct text, and hides the cause — the handle — so the bug returns.

## References
- [SPEC](../SPEC.md) P4, A1, P3; [QA](../QA.md) §2 (`encoding.utf8`); [ENVIRONMENT](../ENVIRONMENT.md)
  §4 and §6; [ADR 0004](./0004-filesystem-frame-transport-first.md); prior art: the mojibake sample
  [复现全流程.md](../../reference/dalabengba-mv/复现全流程.md), and the GBK/LRC notes in
  [fx_player.md](../../reference/dalabengba-mv/docs/api/fx_player.md).
