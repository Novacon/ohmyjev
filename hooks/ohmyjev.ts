import type { Register } from 'claude-code'
import { readConfig } from './policy.ts'

export const register: Register = (_on, options) => {
  readConfig(options)
}
