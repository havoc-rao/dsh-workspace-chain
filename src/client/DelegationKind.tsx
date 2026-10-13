import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-jobs/client'
import { DELEGATION_NS } from './delegation-locales.js'

export function DelegationKind({ t }: PropsRuntime<'conversation.session.jobs.kind'> & PropsLocale<typeof DELEGATION_NS>) {
  return <>{t('kind')}</>
}
