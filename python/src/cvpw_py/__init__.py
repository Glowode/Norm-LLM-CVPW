"""cvpw_py — server-side analysis for the Norm-LLM-CVPW framework.

The package is deliberately small and dependency-light. `numpy` and `soundfile` are the only hard
requirements and both ship binary wheels, so a fresh machine can run `cvpw analyze` without a
compiler, and `librosa` is an optional upgrade that improves tempo estimation without being able to
break the toolchain by its absence (docs/SPEC.md P7).

Everything in here obeys two rules from the framework spec:

- **Determinism.** Same input, same numbers, on any machine. No clocks, no unseeded randomness
  (docs/SPEC.md D1). `generatedAt` is null in every artifact this package writes.
- **Declare your own uncertainty.** Every analysis result carries a confidence and a prose `notes`
  field, because an analysis that hides its error is worse than one that admits it (docs/SPEC.md A7).
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
