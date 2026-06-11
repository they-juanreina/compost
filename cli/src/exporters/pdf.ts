import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { scrubbedEnv } from '../lib/childEnv.js'
import { type PdfRenderer, reportToHtml } from './html.js'
import type { ReportInput } from './report.js'

const execFileAsync = promisify(execFile)

/** Default renderer: headless Chromium (Chrome/Chromium must be on PATH).
 * Tries common binary names; the seam is injectable so tests don't need a browser. */
export const chromiumRenderer: PdfRenderer = async (html, outPath) => {
  const dir = mkdtempSync(join(tmpdir(), 'compost-pdf-'))
  const htmlPath = join(dir, 'report.html')
  writeFileSync(htmlPath, html, 'utf8')
  const bins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  let lastErr: unknown
  for (const bin of bins) {
    try {
      await execFileAsync(
        bin,
        [
          '--headless',
          '--no-sandbox',
          `--print-to-pdf=${outPath}`,
          '--no-pdf-header-footer',
          `file://${htmlPath}`,
        ],
        { env: scrubbedEnv() }, // a browser rendering local HTML needs no secrets (#236)
      )
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`no headless Chromium found (tried ${bins.join(', ')}): ${String(lastErr)}`)
}

/** Render a report to a PDF at outPath. The renderer is injectable (the CLI
 * uses chromiumRenderer; tests pass a fake). Returns the generated HTML. */
export async function exportReportPdf(
  report: ReportInput,
  outPath: string,
  renderer: PdfRenderer = chromiumRenderer,
): Promise<string> {
  const html = reportToHtml(report)
  await renderer(html, outPath)
  return html
}
