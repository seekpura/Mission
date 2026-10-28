import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'mission-live-launcher-host'

export function apply(ctx) {
  provideCmdline(ctx, {
    args: ['--permission-mode', 'workspace-write', 'MISSION_RUNTIME_LIVE_SMOKE'],
    exit: code => {
      if (code !== 0) throw new Error(`DSH live launcher requested exit ${code}`)
    },
  })
}
