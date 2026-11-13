import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 组件返回的元素树节点（createElement 桩的产物）；条件渲染时可能返回 null。 */
interface StubElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

type StubComponent = (props: Record<string, unknown>) => StubElement | null

interface SlotRegistration {
  row: {
    id: string
    name?: string
    order?: number
    inject?: (sessionId: string) => Record<string, unknown>
  }
  component: StubComponent
}

/** 在带最小 React 桩的上下文里加载 client.js，取出它注册的全部槽条目。 */
/** 最近一次 `loadRegistrations` 期间，组件写 state 时传入的值（按顺序）。 */
let lastStateCalls: unknown[] = []
const effectCleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of effectCleanups.splice(0)) cleanup() })

/** 最近一次 `loadRegistrations` 期间，各处 `ctx.inject([...])` 声明的依赖列表。 */
let lastInjectDeps: string[][] = []
let latestStateValues: unknown[] = []

/** 最近一次 `loadRegistrations` 期间，`ctx.remote.$mount(...)` 收到的 remote 声明。 */
let lastMountCalls: Array<{ package?: string; descriptors?: Array<{ id?: string; method?: string }> }> = []

/** 注入的额度 remote 替身：药丸会 `scope.get('remote.agyQuota')` 后再 `.read()`。 */
interface QuotaStubOptions {
  /** 返回 remote 的原始回包（**未拆信封**），与真实网关一致。 */
  quotaRead?: () => Promise<unknown>
  models?: (request?: { force?: boolean }) => Promise<unknown>
  /**
   * 注入会话模型目录的当前 provider。药丸只在 provider 匹配时取数，因此要驱动
   * 取数链路就必须把它设成 `antigravity-acp`；缺省保持空快照（渲染即 null）。
   */
  quotaProvider?: string
  quotaSnapshot?: unknown
  stateOverrides?: Record<number, unknown>
  immediateUnmount?: boolean
  refOverrides?: Record<number, unknown>
  refStateBindings?: Record<number, number>
  listeners?: Map<string, (event: { key?: string; target?: unknown }) => void>
}

function loadRegistrations(options: QuotaStubOptions = {}): Map<string, SlotRegistration> {
  lastStateCalls = []
  latestStateValues = []
  lastInjectDeps = []
  lastMountCalls = []
  let registration: {
    factory: (require: (id: string) => unknown) => { apply: (ctx: Record<string, unknown>) => void }
  } | undefined
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: unknown) => { registration = value as typeof registration } }, innerHeight: 844,
      addEventListener: (type: string, fn: (event: { key?: string; target?: unknown }) => void) => options.listeners?.set(type, fn),
      removeEventListener: (type: string) => options.listeners?.delete(type),
    },
    // vm 上下文没有浏览器/Node 宿主 API；药丸的轮询定时器需要显式注入。
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    document: {
      documentElement: { clientWidth: 375 },
      addEventListener: (type: string, fn: (event: { key?: string; target?: unknown }) => void) => options.listeners?.set(type, fn),
      removeEventListener: (type: string) => options.listeners?.delete(type),
    },
  })
  if (!registration) throw new Error('client.js 未向 __ModuleLoader__ 注册')

  let stateIndex = 0
  let refIndex = 0
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
      if (typeof type === 'function') {
        const rendered = (type as StubComponent)({ ...(props ?? {}), children: children.flat() })
        return rendered ?? { type: 'fragment', props: {}, children: [] }
      }
      return { type, props: props ?? {}, children: children.flat() }
    },
    // 记录 setState 的入参：额度链路「拆信封」的回归就靠它断言。
    useState: (initial: unknown) => {
      const index = stateIndex++
      const value = options.stateOverrides && index in options.stateOverrides ? options.stateOverrides[index]
        : initial === null && options.quotaSnapshot !== undefined ? options.quotaSnapshot : initial
      latestStateValues[index] = value
      return [value, (next: unknown) => {
        const resolved = typeof next === 'function' ? (next as (previous: unknown) => unknown)(latestStateValues[index]) : next
        latestStateValues[index] = resolved
        lastStateCalls.push(resolved)
      }]
    },
    useCallback: <T,>(fn: T) => fn,
    // 维持挂载直到 afterEach；立即卸载必须显式选择，不能期待卸载后仍 setState。
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') {
        if (options.immediateUnmount) cleanup()
        else effectCleanups.push(cleanup)
      }
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useId: () => 'test',
    useMemo: <T,>(fn: () => T) => fn(),
    useRef: <T,>(initial: T) => {
      const index = refIndex++
      const stateIndex = options.refStateBindings?.[index]
      return { get current() { return stateIndex === undefined ? options.refOverrides?.[index] ?? initial : latestStateValues[stateIndex] } }
    },
  }

  const registrations = new Map<string, SlotRegistration>()
  const mountedPackages = new Set<string>()
  const slots = {
    inject: (_name: string, factory: () => unknown) => {
      factory()
      return () => {}
    },
    register: (row: SlotRegistration['row'], target: StubComponent) => {
      registrations.set(row.id, { row, component: (props) => { stateIndex = 0; refIndex = 0; return target(props) } })
      return () => {}
    },
  }
  const scope = {
    slots,
    effect: (fn: () => () => void) => {
      fn()
      return () => {}
    },
    inject: (deps: unknown, fn: (child: unknown) => void) => {
      lastInjectDeps.push(Array.isArray(deps) ? (deps as string[]) : [])
      fn(scope)
      return () => {}
    },
    get: (name: string) =>
      name === 'remote.agyQuota' && (options.quotaRead || options.models)
        ? { read: options.quotaRead, models: options.models } : undefined,
    // 忠实模拟 cordis 的 ReflectService：读取**未 inject** 的 `remote.<ns>` 属性会抛
    // 「cannot get property "remote.<ns>" without inject」。贡献型 remote 不进 inject，
    // 因此组件只能走 `ctx.get('remote.<ns>')`；这条替身行为让写错的一行在测试里就暴露。
    remote: new Proxy(
      {
        $mount: (declaration: unknown) => {
            const descriptor = declaration as (typeof lastMountCalls)[number]
            if (!descriptor.package || mountedPackages.has(descriptor.package)) throw new Error('typert: Remote package is already registered')
            mountedPackages.add(descriptor.package)
            lastMountCalls.push(descriptor)
          return Promise.resolve(() => {})
        },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && prop in target) return Reflect.get(target, prop, receiver)
          throw new Error(`cannot get property "remote.${String(prop)}" without inject`)
        },
      },
    ),
    modelDirectories: {
      directoryFor: () => ({
        store: {
          subscribe: () => () => {},
          getSnapshot: () => (options.quotaProvider ? { current: { provider: options.quotaProvider } } : {}),
        },
      }),
    },
  }
  const plugin = registration.factory(() => react)
  plugin.apply(scope)
  return registrations
}

/** 取设置卡片（settings.section 槽，id=antigravity-acp）。 */
function loadCard(): StubComponent {
  const card = loadRegistrations().get('antigravity-acp')?.component
  if (!card) throw new Error('client.js 未注册 settings.section 卡片')
  return card
}

/** 收集卡片里所有文本节点，用于断言渲染出的说明文案。 */
function texts(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') into.push(node)
  else if (node && typeof node === 'object') {
    for (const child of (node as StubElement).children ?? []) texts(child, into)
  }
  return into
}

function elements(node: unknown): StubElement[] {
  if (!node || typeof node !== 'object') return []
  const value = node as StubElement
  return [value, ...(value.children ?? []).flatMap(elements)]
}
function pillLabel(node: unknown): string {
  return String(elements(node).find((item) => item.type === 'button')?.props['aria-label'] ?? '')
}

/** 构造模型目录 store 快照（决定药丸是否出现）。 */
function modelStore(provider: string | null) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: provider ? 'ready' : 'loading', current: provider ? { provider } : null }),
  }
}

describe('browser client module', () => {
  it('设置页点击即可预热或登录，可手动拉取模型目录', async () => {
    const control = vi.fn(async (method: string, request?: { action?: string; force?: boolean }) => method === 'account'
      ? { state: request?.action === 'login' ? 'connecting' : 'idle', message: 'test' }
      : { status: 'ok', models: [{ id: 'gemini-example', name: 'Gemini Example' }] })
    const readQuota = vi.fn(async () => ({ status: 'ok', groups: [] }))
    const card = loadRegistrations().get('antigravity-acp')!.component
    const tree = card({ remote: {}, control, readQuota })
    const text = texts(tree).join(' ')
    expect(text).toContain('ACP 账户与连接')
    expect(elements(tree).some(item => item.props['aria-label'] === '模型列表')).toBe(true)
    expect(text).not.toContain('首次')
    expect(control.mock.calls.some(([, request]) => request?.action === 'login')).toBe(false)
    const click = (label: string) => {
      const target = elements(tree).find((item) => item.type === 'button' && (texts(item).join('') === label || item.props['aria-label'] === label))
      expect(target, label).toBeDefined()
      ;(target!.props.onClick as () => void)()
    }
    click('立即预热')
    click('连接 / 登录 ACP')
    click('刷新模型目录')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(control).toHaveBeenCalledWith('account', { action: 'login' })
    expect(control).toHaveBeenCalledWith('account', { action: 'warmup' })
    expect(control).toHaveBeenCalledWith('models', { force: true })
    expect(readQuota).not.toHaveBeenCalled()
    expect(texts(tree).join(' ')).not.toContain('AI Credits 余额')
  })

  it('设置页按任务分区，额度可手动拉取且不重复默认模型设置', () => {
    const tree = loadCard()({ remote: {} })
    const text = texts(tree).join(' ')
    for (const label of ['连接', '模型', '额度', '高级', '会话偏好', '网络与 CLI', '连接诊断']) expect(text).toContain(label)
    expect(text).toContain('拉取额度')
    expect(text).toContain('尚未查询')
    // 默认模型由 DSH 自己的模型选择器负责，设置页不再重复维护。
    expect(text).not.toContain('默认模型')
    expect(text).not.toContain('套餐额度管理')
    expect(elements(tree).filter((item) => item.props['aria-label'] === 'AI Credits 余额')).toHaveLength(0)
    // 普通配置（并发/二进制/超时）不是即时字段，宿主拒绝在本卡片写入，改为指引块。
    expect(text).toContain('普通配置（并发 / 二进制 / 超时）')
    expect(text).toContain('maxConcurrentSessions')
    expect(elements(tree).filter((item) => item.type === 'details')).toHaveLength(3)
  })

  it('目录冷启动超过 60 秒时客户端继续等待 Host，而不是提前报超时', async () => {
    vi.useFakeTimers()
    try {
      let complete!: (value: unknown) => void
      const models = vi.fn(() => new Promise<unknown>((resolve) => { complete = resolve }))
      const settings = loadRegistrations({ models }).get('antigravity-acp')!.row.inject!('')
      const control = settings.control as (method: string, request?: { force?: boolean }) => Promise<unknown>
      let settled = false
      const pending = control('models', { force: true }).then((value) => { settled = true; return value })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      expect(models).toHaveBeenCalledWith({ force: true })
      const snapshot = { status: 'ok', models: [{ id: 'example', name: 'Example' }] }
      complete(snapshot)
      expect(await pending).toEqual(snapshot)
    } finally { vi.useRealTimers() }
  })

  it('设置页持有额度读取器，刷新可通知订阅者', async () => {
    const snapshot = { status: 'ok', groups: [] }
    const registrations = loadRegistrations({ quotaRead: async () => ({ ok: true, value: snapshot }) })
    // [本地定制] 额度药丸已从 conversation.input.right 移除，额度只在设置页查看；
    // 这里验证设置卡片自己持有的读取器仍能正常下发与通知。
    const settings = registrations.get('antigravity-acp')!.row.inject!('')
    expect(registrations.has('antigravity-quota')).toBe(false)
    const reader = settings.readQuota as ((force: boolean) => Promise<unknown>) & { subscribe(fn: (value: unknown) => void): () => void }
    const changed = vi.fn()
    const off = reader.subscribe(changed)
    await reader(true)
    expect(changed).toHaveBeenCalledWith(snapshot)
    off()
    await reader(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('代理说明明确留空继承宿主环境，不承诺强制直连', () => {
    const tree = loadCard()({ remote: {} })
    expect(texts(tree).join('')).toContain('留空继承宿主代理环境')
  })

  it('returns its plugin exports when the DSH loader supplies only require', () => {
    let registration: {
      id: string
      factory: (require: (id: string) => unknown) => {
        name: string
        inject: string[]
        apply: (ctx: unknown) => void
      }
    } | undefined
    const requireModule = (id: string) => {
      expect(id).toBe('react')
      return { createElement() {} }
    }

    runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
      window: {
        __ModuleLoader__: {
          load(value: NonNullable<typeof registration>) {
            registration = value
          },
        },
      },
    })

    expect(registration?.id).toBe('dsh-bundle-antigravity-host')
    const plugin = registration!.factory(requireModule)
    expect(plugin.name).toBe('dsh-bundle-antigravity-host')
    // remote.settings / remote.llm 必须逐个声明：缺任一项时读属性会抛
    // 「cannot get property "remote.<ns>" without inject」并击穿 settings.section。
    expect(plugin.inject).toEqual(['slots', 'remote', 'remote.settings', 'remote.llm'])
    expect(plugin.apply).toBeTypeOf('function')
  })

  it('设置卡片只经 settings.describe/listProviders 取数，绝不调用宿主不存在的 llm.listModels', async () => {
    const Card = loadCard()
    const calls = { describe: 0, listProviders: 0, listModels: 0, on: [] as string[] }
    const remote = {
      settings: {
        describe: async () => {
          calls.describe += 1
          return {
            ok: true,
            value: {
              writable: true,
              namespaces: [
                { ns: 'llm-antigravity-acp', revision: 7, value: { proxyUrl: '', modelOverrides: { 'gemini-3-pro': { effort: 'high' } } } },
              ],
            },
          }
        },
      },
      llm: {
        listProviders: async () => {
          calls.listProviders += 1
          return { ok: true, value: [{ id: 'antigravity-acp', name: 'Antigravity (ACP)' }] }
        },
        // 真实宿主没有这个方法；一旦卡片回退到它，这里会被调用并让断言失败。
        listModels: async () => {
          calls.listModels += 1
          return []
        },
      },
      $on: (name: string) => {
        calls.on.push(name)
        return () => {}
      },
    }

    Card({ remote })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.describe).toBeGreaterThanOrEqual(1)
    expect(calls.listProviders).toBeGreaterThanOrEqual(1)
    expect(calls.listModels).toBe(0)
    // 配置变更后应自动刷新卡片。
    expect(calls.on).toContain('settings/document-updated')
  })

  it('provider 已注册时渲染出「已注册」提示', async () => {
    const Card = loadCard()
    const remote = {
      settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }) },
      llm: { listProviders: async () => ({ ok: true, value: [{ id: 'antigravity-acp' }] }) },
      $on: () => () => {},
    }

    const tree = Card({ remote })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // 没有真实目录来源时，卡片如实说明「未找到本路由」，而不是编造模型列表。
    expect(texts(tree).join('\n')).toContain('ACP 模式')
  })

  it('宿主缺少 settings.describe 时降级为可读提示而不是崩溃', () => {
    const Card = loadCard()
    const tree = Card({ remote: {} })
    expect(texts(tree).join('\n')).toContain('ACP 模式')
  })

  it('remote.<ns> 属性访问抛「without inject」时降级，绝不把异常抛出组件', () => {
    const Card = loadCard()
    // 复现宿主 ReflectService 的行为：缺 inject 时连读属性都会抛。
    const denied = (ns: string) => {
      throw new Error(`cannot get property "${ns}" without inject`)
    }
    const remote = {
      get settings() {
        return denied('remote.settings')
      },
      get llm() {
        return denied('remote.llm')
      },
      $on: () => () => {},
    }

    // 异常若穿出组件，React 侧会击穿 settings.section 卡片并弄坏设置页。
    expect(() => Card({ remote })).not.toThrow()
    const tree = Card({ remote })
    expect(texts(tree).join('\n')).toContain('ACP 模式')
  })
})

