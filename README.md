# Paper Reader（本機版）

**在自己電腦上讀論文的 AI 閱讀器。** 點一下論文裡的圖表或演算法就能請 AI 逐步解釋；中英雙語左右對照；像 Adobe 一樣畫螢光筆、加文字、寫筆記，並真正存進 PDF。不需要任何付費 API key：AI 直接使用你已登入的 **Codex CLI** 或 **Claude Code** 訂閱，PDF 解析用本機 **MinerU**，選區翻譯用本機 **Ollama**。

> 介面為台灣繁體中文，以 Windows + Chrome／Edge 為主要環境。改編自 [wenhuahuo/PaperReader](https://github.com/wenhuahuo/PaperReader)（MIT）。

## 🚀 三步開始使用

### [⬇ 下載 Paper Reader（ZIP）](../../archive/refs/heads/main.zip)

1. 點上面的連結下載 ZIP，**解壓縮**到任何資料夾（例如「文件」）。
2. 打開資料夾，**雙擊 `Paper Reader.exe`**（藍底白色「P」圖示，資料夾裡唯一的程式）。
3. 第一次會問「要現在安裝嗎？」→ 按 **是**。安裝視窗會自動裝好需要的東西（Node.js、PDF 解析、翻譯工具，約 2 GB），並引導你登入 ChatGPT（Codex）。裝好後自動開啟，之後雙擊 exe 或桌面捷徑即可。

> 需要：Windows 10／11、網路，以及 ChatGPT（Codex）或 Claude 訂閱其中一個。
> 第一次執行時 Windows 可能跳出「Windows 已保護您的電腦」（exe 沒有付費數位簽章）：按 **其他資訊 → 仍要執行**。
> 每次更新都會在[全新的 Windows 上自動測試](../../actions)「下載 → 安裝 → 開啟」整個流程。

![整體畫面：左邊閱讀論文，右邊 AI 助手整理全文摘要](docs/images/overview.png)

## 主要功能

### 1. 點圖表、演算法、公式，直接問 AI

滑鼠移到論文上的圖、表、演算法或公式會出現虛線框，點一下就附加到右側助手，也可以從「圖表清單」挑選。附給 AI 的不是模糊截圖，而是 MinerU 解析出的**論文原文**（演算法全文、LaTeX 公式、表格內容）加上原圖。按住 `Ctrl` 可以多選，一起「比較這些」。

![點選 Figure 1 與圖表清單](docs/images/figure-click.png)

### 2. 演算法逐步解釋（可選簡單／中度／詳細）

框選或點選演算法，按「逐步解釋演算法」，AI 會先在全文找到原文，再逐行說明、列出符號表，並代入小數字實際走一遍。解釋深度可切換 **簡單／中度／詳細**，舉例可選 **簡單舉例／完整舉例**。

![框選 Algorithm 2 並逐步解釋](docs/images/algorithm.png)

**實際輸出節錄**（Mamba 論文 Algorithm 2，Claude Sonnet）：

> **Algorithm 2：SSM + Selection（S6）**
> 原文位於 Section 3.2「Improving SSMs with Selection」……
>
> | 行 | 原文 | 做什麼、為什麼 |
> |---|---|---|
> | 2 | `B : (B,L,N) ← s_B(x)` | B 由輸入投影得到，決定「當前輸入有多少寫進狀態」。 |
> | 4 | `Δ : (B,L,D) ← τ_Δ(Parameter + s_Δ(x))` | Δ 是步長，決定要「重置、忽略」還是「保留」狀態；softplus 保證 Δ > 0。 |
> | 6 | `y ← SSM(Ā,B̄,C)(x)` | 因為 Ā、B̄ 每個時間步都不同，不能再用卷積，只能用遞迴（scan）。 |
>
> 接著是符號表（B、L、D、N 的意義與維度）、小數值例子，以及與 Algorithm 1、Figure 2 的對照。

### 3. 中英雙語左右對照

匯入時可勾選「自動整篇翻譯」（PDFMathTranslate），之後在原文、中文、雙語之間切換。雙語版左右**對稱**：選右邊的中文段落，會自動找出左邊對應的英文原文（反之亦然），按「翻譯」立即顯示，不需再呼叫模型；右邊的中文圖表一樣可以點選。

![選取中文段落，下方立即顯示英文原文對照](docs/images/bilingual.png)

### 4. 螢光筆、文字、筆記，真正存進 PDF

- 選取文字後浮出工具列：四色螢光筆、註記；也可以「左鍵拖曳時按右鍵」、滑鼠側鍵或 `H` 直接畫黃色重點。
- 「T 文字」在頁面任何位置加文字，可選顏色、字型、大小、粗斜體與便利貼底色。
- `Ctrl+Z` 復原、`Ctrl+Y` 重做；`Ctrl+S` 把所有螢光筆、註記、文字寫成**標準 PDF 標註**（嵌入字型，Adobe Acrobat、Chrome、Edge 都看得到），存到匯出資料夾並保留上一版備份。
- 「筆記」分頁集中列出所有重點，可匯出成 Markdown。

![螢光筆、文字註解與筆記編輯](docs/images/highlight.png)

### 5. 其他

- **對話有記憶**：每篇論文的對話存在本機，重開後可以接著追問。
- **選段落、選名詞**：**三擊文字直接選取整段**（依 MinerU 解析的段落邊界；或按選取工具列的「¶ 整段」擴大），可「解釋這段／翻譯」；只選幾個字會變成「解釋這個名詞」。
- **隨時切換模型**：助手頂部顯示目前模型，點一下切換 Codex／Claude、模型與思考強度。
- **雙螢幕**：助手可以開成獨立視窗（可最大化、拖到另一個螢幕），也可以收起左欄、把助手拉出浮動。
- **閱讀器**：適合寬度／頁面、`Ctrl+滾輪` 縮放、`Ctrl+F` 全文搜尋、方向鍵翻頁、高解析度渲染；按 `?` 顯示所有快捷鍵。
- **App 模式**：以 Chrome／Edge App 視窗開啟（沒有網址列），可建立桌面捷徑。

## 安裝

上面的「三步開始使用」就是完整安裝流程。資料夾結構：

```
Paper Reader\
├─ Paper Reader.exe   ← 只要點這個
├─ README.md
└─ app\               ← 程式本體（不用動）
```

`Paper Reader.exe` 第一次執行時會呼叫 `app\setup.ps1 -MinerU -Translate`（也可以自己執行）：缺 Node.js 會自動安裝、安裝套件與建置、把 MinerU 裝到 `app\tools\mineru`（含模型約 1.5 GB）、把整篇翻譯用的 `pdf2zh_next` 裝到 `app\tools\pdf2zh`、安裝並引導登入 Codex CLI，最後在桌面建立「Paper Reader」捷徑。程式在 http://127.0.0.1:3080 執行，以沒有網址列的 App 視窗開啟。

想自己編譯 exe：執行 `app\scripts\build-launcher.ps1`，會用 Windows 內建的 C# 編譯器把 `app\launcher\PaperReader.cs` 編成 `Paper Reader.exe`。

### 需要的外部工具

| 用途 | 工具 | 說明 |
|---|---|---|
| AI 助手（預設） | [Codex CLI](https://github.com/openai/codex) | 安裝程式會自動安裝並引導 `codex login`（使用 ChatGPT 訂閱） |
| AI 助手（可選） | [Claude Code](https://docs.anthropic.com/claude-code) | 安裝後登入 Claude 訂閱帳號 |
| PDF 解析 | [MinerU](https://github.com/opendatalab/MinerU) | 安裝程式自動安裝；也可用環境變數 `MINERU_KIT`／`MINERU_HOME` 或在「設定」頁指定 |
| 選區翻譯（可選） | [Ollama](https://ollama.com/) | `ollama pull hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M`；也可改用 Codex／Claude 翻譯 |
| 整篇翻譯（可選） | [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next) | 安裝程式自動安裝；翻譯服務沿用 Codex／Claude 訂閱或本機 Ollama，橋接腳本在 `app/pdf-translate/` |

沒裝的工具只會讓對應功能無法使用；閱讀、螢光筆、筆記等功能不受影響。

## 使用小提示

- **建議匯入英文原文**：解析與 AI 回答品質最好；要看中文再用「整篇翻譯」。已翻譯的雙語 PDF 也能匯入，系統會自動辨識並停用重複翻譯。
- **解析只做一次**：結果存在本機，之後開啟直接沿用；需要時按「重新解析」。
- **資料都在本機**：論文、解析、對話、螢光筆與設定都在 `app\.runtime\`。只有你提問時的內容會送到 Codex／Claude。

## 快捷鍵

| 按鍵 | 功能 |
|---|---|
| `H`、左鍵拖曳＋右鍵、滑鼠側鍵 | 用預設顏色畫重點 |
| `T` | 加入文字 |
| `Ctrl+Z`／`Ctrl+Y` | 復原／重做 |
| `Ctrl+S` | 把標註存進 PDF |
| 三擊文字 | 選取整段 |
| `Ctrl`＋點圖表 | 多選附件 |
| `Ctrl+F` | 搜尋 PDF 全文 |
| `←` `→`、`PageUp` `PageDown` | 翻頁 |
| `Ctrl`＋滾輪 | 縮放 |
| `?` | 顯示快捷鍵表 |

## 開發

```powershell
cd app
npm.cmd run check   # 單元測試
npm.cmd run build   # 建置前端到 dist/
npm.cmd start       # 啟動服務（PORT 預設 3080）
```

## 授權與致謝

- 本專案以 MIT 授權釋出（`app/pdf-translate/` 因使用 AGPL-3.0 的 pdf2zh_next，該資料夾為 AGPL-3.0），改編自 [wenhuahuo/PaperReader](https://github.com/wenhuahuo/PaperReader)（MIT）。
- 截圖中的論文為 Gu & Dao, *Mamba: Linear-Time Sequence Modeling with Selective State Spaces*（[arXiv:2312.00752](https://arxiv.org/abs/2312.00752)，CC BY 4.0），節錄前 7 頁作為示範，中文譯文由本工具產生。
- 使用 [pdf.js](https://github.com/mozilla/pdf.js)、[pdf-lib](https://github.com/Hopding/pdf-lib)、[KaTeX](https://katex.org/)、[MinerU](https://github.com/opendatalab/MinerU) 等開源專案。
