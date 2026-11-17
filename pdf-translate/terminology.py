"""各翻譯服務共用的英文技術術語政策。"""

# 2026-11 NAS-FCOS 評測歸納的共同弱點：程度語氣被改強／弱、負號作用範圍含糊、
# 「參數量」漏「量」、跨頁斷句被補成整句、大陸用語（檢測頭）、翻譯腔與跨段用詞不一。
TAIWAN_STYLE_POLICY = (
    "Write natural Taiwan academic Chinese, not word-for-word translationese: reorder clauses "
    "freely, but never add, drop, strengthen or weaken a claim. "
    # v2 實測：Sol 因「不得增加」退回直譯「樣本在…之間」，失去「抽樣所得的架構」的清楚指代。
    "When context makes a vague referent certain, name it (samples -> 抽樣所得的架構); "
    "that clarifies, it does not add a claim. Keep hedging and degree words "
    "exact (promise, may, suggest, excessive, slightly, significantly, only). Make operator scope "
    "unambiguous, e.g. negative loss sum = 損失總和的負值, not 負損失總和. Keep quantity nouns: "
    "number of parameters / Params = 參數量. Items may be fragments cut at page or column breaks: "
    "translate only the words present, never complete the sentence or add closing punctuation. "
    "Use full-width punctuation in Chinese prose. Use Taiwan terms, not Mainland ones: "
    "parameter=參數 (not 引數), hyper-parameter=超參數, algorithm=演算法, detection=偵測, "
    "detection head=偵測頭, data=資料, information=資訊, network=網路, quality=品質, "
    "robust=穩健, recurrent neural network=遞迴神經網路, instance=實例, paradigm=範式. "
    "Keep structure=結構 distinct from architecture=架構. Use exactly one Chinese rendering per "
    "English term across the whole document; when unsure, keep the English term. "
)

# 基礎技術詞也保留英文；使用原文中的完整片語，不以中文加括號替代。
ENGLISH_TERMS_POLICY = (
    "Use Traditional Chinese for connective prose, but retain technical nouns, "
    "adjectives and complete technical phrases in their original English wording. "
    "This includes basic terms, not only proper names: register, memory, cache, "
    "kernel, thread, warp, dataflow, throughput, latent state, hidden state, "
    "high-dimensional latent state, state space model, SSM, "
    "discrete, continuous, discrete-time, continuous-time, discretization, "
    "discretize, convolution, attention, gating, recurrence, "
    "parallel associative scan, activation, projection and initialization. "
    "Preserve the source spelling, abbreviation, modifiers, hyphenation and plural form; "
    "keep the full phrase together, e.g. high-dimensional latent state, "
    "rather than translating its modifiers into Chinese. "
    "Do not replace these with Chinese equivalents or Chinese followed by English "
    "in parentheses. Preserve English model, algorithm, dataset and metric names. "
    "Retain the English actually used by the source; do not invent technical terms "
    "for ordinary nontechnical prose (e.g. contiguous is not continuous). "
    "A supplied glossary controls other terms, but these listed terms stay in English. "
)
