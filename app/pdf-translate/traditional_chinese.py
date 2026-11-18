"""統一模型輸出的繁體字形，同時保留公式、標記與程式碼。"""
from functools import lru_cache
import re
from opencc import OpenCC

# 只轉換文字敘述；標記屬性、數學與程式碼不可套用字形轉換。
PROTECTED = re.compile(r"(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|</?[^>\n]+>|\{\{[^{}\n]+\}\}|\{v\d+\}|\[v\d+\])")
# 以句為單位判斷：已是繁體的句子原樣保留，只轉換真的含簡體字的句子。
CLAUSE = re.compile(r"([。！？；!?;\n]+)")
# 舊版用 s2twp 詞彙轉換，會把模型已寫好的臺灣用語再轉一次：
# 演算法→演演算法、參數→引數、範式→正規化、程序→程式、對象→物件、擴展→擴充套件、
# 循環→迴圈、實例→例項；s2tw 的字詞表也會把「證明了」改成「證明瞭」。
# 改為 s2tw 字形轉換，再套用下列少數無歧義的大陸→臺灣詞彙。
TAIWAN_TERMS = ((re.compile(r"(?<!演)算法"), "演算法"), (re.compile("軟件"), "軟體"),
                (re.compile("硬件"), "硬體"), (re.compile("數據"), "資料"), (re.compile("網絡"), "網路"),
                (re.compile("信息"), "資訊"), (re.compile("視頻"), "影片"), (re.compile("默認"), "預設"),
                (re.compile("魯棒"), "穩健"))

# 模型本身也會輸出「證明瞭」（實測 Opus），現代臺灣用法一律是「證明了」，所有句子都修正。
ALWAYS_FIXES = ((re.compile("證明瞭"), "證明了"),)

@lru_cache(maxsize=1)
def converter():
    # 字形轉換在本機完成，不產生額外模型請求或傳送文件。
    return OpenCC("s2tw")

@lru_cache(maxsize=1)
def _single():
    # 逐字判斷是否為簡體字，不受詞組表影響。
    return OpenCC("s2t")

@lru_cache(maxsize=4096)
def _is_simplified(char: str) -> bool:
    return _single().convert(char) != char

def _convert_clause(clause: str) -> str:
    text = clause
    if any(_is_simplified(char) for char in clause):
        text = converter().convert(clause)
        for pattern, replacement in TAIWAN_TERMS:
            text = pattern.sub(replacement, text)
    for pattern, replacement in ALWAYS_FIXES:
        text = pattern.sub(replacement, text)
    return text

def _convert_prose(text: str) -> str:
    return "".join(_convert_clause(part) for part in CLAUSE.split(text))

def to_traditional(text: str) -> str:
    pieces = PROTECTED.split(text)
    return "".join(part if index % 2 else _convert_prose(part)
                   for index, part in enumerate(pieces))
