import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// From cli/src/lib/templates.ts the templates live at ../../templates.
// From cli/dist/lib/templates.js the same relative path resolves to
// cli/templates (templates/ is a sibling of both src/ and dist/).
const TEMPLATES_ROOT = join(__dirname, '..', '..', 'templates')

export function loadTemplate(name: string): string {
  return readFileSync(join(TEMPLATES_ROOT, name), 'utf8')
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) {
      throw new Error(`render: template references unknown variable "${key}"`)
    }
    return value
  })
}
