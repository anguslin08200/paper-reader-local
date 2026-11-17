# 整篇翻譯（PDFMathTranslate 橋接）

Paper Reader 的「整篇翻譯」會呼叫這裡的 `Translate-PDF.ps1`，用 [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（`pdf2zh_next`）保留版面與公式，產生台灣繁體中文版與左右雙語版 PDF。

- 安裝：在專案根目錄執行 `.\setup.ps1 -Translate`，會把 `pdf2zh_next` 裝到 `tools\pdf2zh`。
- 翻譯服務：`Codex`（ChatGPT 訂閱，需先 `codex login`）、`Claude`（Claude Code 訂閱）或 `Local`（本機 Ollama）。不使用 API key，橋接程式會移除繼承的 API key 環境變數，避免誤用付費 API。
- 批次翻譯：同一批段落一起送出，驗證公式佔位符，失敗只重試不合格的段落；合格譯文快取在 `%LOCALAPPDATA%\PDFMathTranslate`。
- 圖、表內文字維持原樣，不被重新排版；輸出經 OpenCC 轉為台灣用語。

單獨使用：

```powershell
.\pdf-translate\Translate-PDF.ps1 paper.pdf -OutputDirectory out -Provider Codex -Effort low
```

## 授權

此資料夾的腳本會在執行時載入並修補 `pdf2zh_next` 與 `babeldoc`（AGPL-3.0），因此本資料夾以 **AGPL-3.0** 釋出；專案其他部分維持 MIT。`pdf2zh_next` 本身不隨附，由 `setup.ps1` 從 PyPI 安裝。
