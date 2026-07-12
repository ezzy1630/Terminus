"""SPEC §41.6 statistical practice.

Pure-Python statistics for paired comparisons, bootstrap CIs, multiple
comparisons, effect sizes, and non-inferiority tests. No SciPy dependency.
"""

from __future__ import annotations

from .bootstrap import (
    BootstrapCI,
    BootstrapDistribution,
    bootstrap_ci,
    bootstrap_ci_bca,
    bootstrap_ci_obj,
    bootstrap_distribution,
    bootstrap_p_value,
    bootstrap_samples,
)
from .effect_size import (
    CliffsDeltaResult,
    EffectSizeResult,
    OddsRatioResult,
    cliffs_delta,
    cohens_d,
    cohens_d_paired,
    cohens_h,
    hedges_g,
    hedges_g_paired,
    odds_ratio,
    relative_risk,
)
from .multiple_comparisons import (
    AdjustedPValues,
    benjamini_hochberg,
    benjamini_yekutieli,
    bonferroni,
    holm_bonferroni,
    reject_decisions,
)
from .noninferiority import (
    NonInferiorityResult,
    noninferiority_binary,
    noninferiority_proportion,
    noninferiority_t_test,
)
from .paired import (
    McNemarResult,
    PairedDelta,
    PairedMeanDelta,
    PairedSequence,
    TestResult,
    mc_nemar,
    paired_mean_delta,
    paired_t_test,
    paired_wilcoxon,
    sign_test,
)

__all__ = [
    "AdjustedPValues",
    "BootstrapCI",
    "BootstrapDistribution",
    "CliffsDeltaResult",
    "EffectSizeResult",
    "McNemarResult",
    "NonInferiorityResult",
    "OddsRatioResult",
    "PairedDelta",
    "PairedMeanDelta",
    "PairedSequence",
    "TestResult",
    "benjamini_hochberg",
    "benjamini_yekutieli",
    "bonferroni",
    "bootstrap_ci",
    "bootstrap_ci_bca",
    "bootstrap_ci_obj",
    "bootstrap_distribution",
    "bootstrap_p_value",
    "bootstrap_samples",
    "cliffs_delta",
    "cohens_d",
    "cohens_d_paired",
    "cohens_h",
    "hedges_g",
    "hedges_g_paired",
    "holm_bonferroni",
    "mc_nemar",
    "noninferiority_binary",
    "noninferiority_proportion",
    "noninferiority_t_test",
    "odds_ratio",
    "paired_mean_delta",
    "paired_t_test",
    "paired_wilcoxon",
    "reject_decisions",
    "relative_risk",
    "sign_test",
]
