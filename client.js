/**
 * dsh-qq-mail-notify 的 Web 端：设置 → 邮件通知。
 *
 * 只做一件事：把 lib/index.js 暴露的三个接口（status / config / test）包成一块
 * 能点的表单。配置的最终解释权仍在 Host 侧（settings.js 的 resolveSettings），
 * 这里不做二次校验，只负责把数字和布尔值按类型送上去。
 *
 * 授权码不回填：接口只给打码后的值，输入框留空表示"不修改"。
 *
 * 文案全部走 DSH 的 locale 服务（ctx.locale.register + bind）：界面语言切到英文时
 * 这块面板跟着变；locale 服务不可用的老宿主退化成中文渲染，但不会报错。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-mail-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const API = '/dsh-qq-mail-notify';

    /** 本插件独占的字典命名空间。 */
    const NS = 'dsh-qq-mail-notify';

    /**
     * 双语字典。键名平铺，不用嵌套——locale 服务按整串键取值。
     * `source_*` 是「配置来源」徽标的文案，键名与 Host 侧 sources 的取值一致。
     */
    const DICT = {
      zh: {
        title: '邮件通知',
        hint: '工作结束时把摘要发到 QQ 邮箱；一轮跑太久会先报进度。',
        progress: '长任务进度通报',
        progressHint: '一轮跑超过这个时长就先发一封进度，0 表示关闭',
        sender: '发件邮箱',
        senderHint: '填完整地址，比如 123456@qq.com',
        authCode: 'SMTP 授权码',
        authCodeHint: 'QQ 邮箱：设置 → 账户 → 开启 SMTP 后生成的 16 位授权码，不是登录密码',
        authCodeKeep: '已保存，留空表示不修改',
        recipient: '收件邮箱',
        recipientHint: '留空则发给发件邮箱自己',
        smtpHost: 'SMTP 服务器',
        smtpPort: '端口',
        secure: '隐式 TLS（465）',
        cadence: '发送节奏',
        cadenceNow: '即时（这一轮结束就发）',
        cadenceBatch: '攒批（停手一段时间合并一封）',
        batchMinutes: '停手多少分钟后汇总',
        prefix: '主题前缀',
        approvalEnable: '工具等你授权时发邮件',
        approvalHint: '回信「允许」或「拒绝」即可；超时自动交回界面，不会替你决定。需要同时安装 dsh-mail-command。',
        approvalPolicyHint: '开关是开的，但当前权限预设不是 workspace-write —— 沙箱放得太开就不会产生审批请求，邮件永远发不出来。关掉再打开一次开关可以重新立起来。',
        approvalTimeout: '等回信时长（分钟）',
        save: '保存',
        test: '发一封测试邮件',
        reload: '重新读取',
        saving: '保存中…',
        testing: '发送中…',
        saved: '已保存',
        tested: '测试邮件已投递',
        ready: '配置完整，可以发送',
        notReady: '还缺少：',
        loading: '读取配置…',
        fileLabel: '配置文件：',
        sourceLabel: '来源：',
        statsLabel: '统计：',
        sent: '已发送',
        progressSent: '进度通报',
        failed: '失败',
        pending: '待发',
        listSep: '、',
        source_session: '会话覆盖',
        source_patch: '插件配置',
        source_file: '配置文件',
        source_env: '环境变量',
        source_preset: '服务商预设',
        source_default: '默认值',
      },
      en: {
        title: 'Mail notifications',
        hint: 'Mails a digest when work stops; a long turn gets a progress note first.',
        progress: 'Long-task progress report',
        progressHint: 'Send a progress mail once a turn runs longer than this; 0 disables it',
        sender: 'Sender address',
        senderHint: 'Full address, e.g. 123456@qq.com',
        authCode: 'SMTP authorization code',
        authCodeHint: 'QQ Mail: Settings → Account → enable SMTP, then use the 16-character code (not your password)',
        authCodeKeep: 'Saved — leave blank to keep it',
        recipient: 'Recipient',
        recipientHint: 'Leave blank to mail the sender address itself',
        smtpHost: 'SMTP host',
        smtpPort: 'Port',
        secure: 'Implicit TLS (465)',
        cadence: 'Send cadence',
        cadenceNow: 'Immediately (when the turn stops)',
        cadenceBatch: 'Batched (merge after idle)',
        batchMinutes: 'Idle minutes before sending',
        prefix: 'Subject prefix',
        approvalEnable: 'Mail me when a tool needs approval',
        approvalHint: 'Reply "allow" or "deny"; on timeout it falls back to the desktop prompt and never decides for you. Requires dsh-mail-command.',
        approvalPolicyHint: 'Enabled, but the current permission preset is not workspace-write — the sandbox is too permissive, so no approval request will ever fire. Toggle the switch off and on to re-arm it.',
        approvalTimeout: 'Wait for reply (minutes)',
        save: 'Save',
        test: 'Send a test mail',
        reload: 'Reload',
        saving: 'Saving…',
        testing: 'Sending…',
        saved: 'Saved',
        tested: 'Test mail delivered',
        ready: 'Ready to send',
        notReady: 'Missing: ',
        loading: 'Loading…',
        fileLabel: 'Config file: ',
        sourceLabel: 'Source: ',
        statsLabel: 'Stats: ',
        sent: 'sent',
        progressSent: 'progress',
        failed: 'failed',
        pending: 'pending',
        listSep: ', ',
        source_session: 'session override',
        source_patch: 'plugin config',
        source_file: 'config file',
        source_env: 'environment',
        source_preset: 'provider preset',
        source_default: 'default',
      },
    };

    /** locale 服务不可用时的兜底（老宿主）：按中文渲染，但不至于报错。 */
    const fallback = (key) => DICT.zh[key] || key;

    async function api(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        ...init,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      return body;
    }

    const fieldStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      marginBottom: 14,
    };
    const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
    const hintStyle = { fontSize: 11, lineHeight: 1.4, color: 'var(--dsw-alias-label-tertiary)' };
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      height: 32,
      padding: '0 10px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-l1, transparent)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
    };
    const buttonStyle = (primary, disabled) => ({
      height: 30,
      padding: '0 14px',
      border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      borderRadius: 8,
      background: primary ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
      color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.55 : 1,
    });

    function Field({ label, hint, children }) {
      return h(
        'div',
        { style: fieldStyle },
        h('label', { style: labelStyle }, label),
        children,
        hint ? h('span', { style: hintStyle }, hint) : null,
      );
    }

    /** 配置来源徽标：认识的取值译成当前语言，认不出来就原样显示（如 preset:163）。 */
    function SourceTag({ source, t }) {
      if (!source) return null;
      const key = `source_${source}`;
      const translated = t(key);
      const text = !translated || translated === key ? String(source) : translated;
      return h(
        'span',
        {
          style: {
            marginLeft: 6,
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 4,
            color: 'var(--dsw-alias-label-tertiary)',
            background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.12))',
          },
        },
        text,
      );
    }

    function SettingsPanel({ t }) {
      const [snapshot, setSnapshot] = useState(null);
      const [form, setForm] = useState(null);
      /** 授权码单独存：接口只回打码值，输入框留空表示「不修改」。 */
      const [draftCode, setDraftCode] = useState('');
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState('');
      const [error, setError] = useState('');

      const applySnapshot = useCallback((data) => {
        setSnapshot(data);
        const s = data.settings || {};
        setForm({
          enabled: s.enabled !== false,
          user: s.user || '',
          to: s.to || '',
          smtpHost: s.smtpHost || '',
          smtpPort: String(s.smtpPort ?? ''),
          secure: s.secure !== false,
          subjectPrefix: s.subjectPrefix || '',
          idleDelayMs: Number(s.idleDelayMs || 0),
          progressEveryMs: Number(s.progressEveryMs || 0),
          approvalMailEnabled: s.approvalMailEnabled === true,
          approvalMailTimeoutMs: Math.round((Number(s.approvalMailTimeoutMs) || 600000) / 60000),
        });
      }, []);

      /** 通用字段更新：checkbox 取 checked，其余取 value。 */
      const set = (key) => (event) => {
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
        setNote('');
      };

      const load = useCallback(async () => {
        try {
          applySnapshot(await api('/status'));
          setError('');
        } catch (e) {
          setError(String(e?.message ?? e));
        }
      }, [applySnapshot]);

      useEffect(() => {
        void load();
      }, [load]);

      const save = async () => {
        if (!form) return;
        setBusy('save');
        setError('');
        try {
          const patch = {
            enabled: form.enabled,
            user: form.user.trim(),
            to: form.to.trim(),
            smtpHost: form.smtpHost.trim(),
            smtpPort: Number(form.smtpPort) || 465,
            secure: form.secure,
            subjectPrefix: form.subjectPrefix,
            idleDelayMs: Math.max(0, Number(form.idleDelayMs) || 0),
            progressEveryMs: Math.max(0, Number(form.progressEveryMs) || 0),
            approvalMailEnabled: form.approvalMailEnabled === true,
            approvalMailTimeoutMs: Math.max(1, Number(form.approvalMailTimeoutMs) || 10) * 60000,
          };
          if (draftCode.trim()) patch.authCode = draftCode.trim();
          applySnapshot(await api('/config', { method: 'POST', body: JSON.stringify(patch) }));
          setDraftCode('');
          setNote(t('saved'));
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      };

      const sendTest = async () => {
        setBusy('test');
        setError('');
        try {
          await api('/test', { method: 'POST' });
          setNote(t('tested'));
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      };

      if (!form || !snapshot) {
        return h('div', { style: { padding: 16, fontSize: 13, opacity: 0.7 } }, error || t('loading'));
      }

      const sources = snapshot.sources || {};
      const stats = snapshot.stats || {};
      const miss = Array.isArray(snapshot.missing) ? snapshot.missing : [];
      const progressMinutes = Math.round((Number(form.progressEveryMs) || 0) / 60000);

      return h(
        'div',
        { style: { padding: '4px 2px 20px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, t('title')),
        h('div', { style: { ...hintStyle, marginBottom: 14 } }, t('hint')),

        h(
          'div',
          {
            style: {
              marginBottom: 16,
              padding: '8px 10px',
              borderRadius: 8,
              fontSize: 12,
              background: snapshot.ready
                ? 'var(--dsw-alias-fill-l2, rgba(77,107,254,.08))'
                : 'var(--dsw-alias-fill-l2, rgba(212,56,13,.10))',
              color: snapshot.ready ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary, #d4380d)',
            },
          },
          snapshot.ready ? t('ready') : t('notReady') + miss.join(t('listSep')),
        ),

        h(
          Field,
          { label: t('sender'), hint: t('senderHint') },
          h('input', {
            style: inputStyle,
            type: 'email',
            value: form.user,
            onChange: set('user'),
            placeholder: '123456@qq.com',
            autoComplete: 'off',
          }),
        ),

        h(
          Field,
          { label: t('authCode'), hint: t('authCodeHint') },
          h('input', {
            style: inputStyle,
            type: 'password',
            value: draftCode,
            onChange: (event) => {
              setDraftCode(event.target.value);
              setNote('');
            },
            placeholder: t('authCodeKeep'),
            autoComplete: 'new-password',
          }),
        ),

        h(
          Field,
          { label: t('recipient'), hint: t('recipientHint') },
          h('input', {
            style: inputStyle,
            type: 'email',
            value: form.to,
            onChange: set('to'),
            placeholder: '123456@qq.com',
            autoComplete: 'off',
          }),
        ),

        h(
          Field,
          { label: t('smtpHost') },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              style: { ...inputStyle, flex: '1 1 auto' },
              value: form.smtpHost,
              onChange: set('smtpHost'),
              placeholder: 'smtp.qq.com',
              autoComplete: 'off',
            }),
            h('input', {
              style: { ...inputStyle, flex: '0 0 84px' },
              type: 'number',
              value: String(form.smtpPort),
              onChange: set('smtpPort'),
              placeholder: '465',
            }),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' } },
              h('input', { type: 'checkbox', checked: form.secure === true, onChange: set('secure') }),
              t('secure'),
            ),
          ),
        ),

        h(
          Field,
          { label: t('cadence') },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' } },
              h('input', {
                type: 'radio',
                checked: Number(form.idleDelayMs) === 0,
                onChange: () => {
                  setForm((prev) => (prev ? { ...prev, idleDelayMs: 0 } : prev));
                  setNote('');
                },
              }),
              t('cadenceNow'),
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' } },
              h('input', {
                type: 'radio',
                checked: Number(form.idleDelayMs) > 0,
                onChange: () => {
                  setForm((prev) => (prev ? { ...prev, idleDelayMs: 600000 } : prev));
                  setNote('');
                },
              }),
              t('cadenceBatch'),
            ),
            Number(form.idleDelayMs) > 0
              ? h('input', {
                  style: { ...inputStyle, marginTop: 2 },
                  type: 'number',
                  min: 1,
                  value: String(Math.max(1, Math.round(Number(form.idleDelayMs) / 60000))),
                  onChange: (event) => {
                    const minutes = Math.max(1, Number(event.target.value) || 1);
                    setForm((prev) => (prev ? { ...prev, idleDelayMs: minutes * 60000 } : prev));
                    setNote('');
                  },
                  placeholder: t('batchMinutes'),
                })
              : null,
          ),
        ),

        h(
          Field,
          { label: t('progress'), hint: t('progressHint') },
          h('input', {
            style: inputStyle,
            type: 'number',
            min: 0,
            value: String(progressMinutes),
            onChange: (event) =>
              setForm((prev) =>
                prev ? { ...prev, progressEveryMs: Math.max(0, Number(event.target.value) || 0) * 60000 } : prev,
              ),
          }),
        ),

        h(
          Field,
          { label: t('prefix') },
          h('input', {
            style: inputStyle,
            value: form.subjectPrefix,
            onChange: (event) => {
              const value = event.target.value;
              setForm((prev) => (prev ? { ...prev, subjectPrefix: value } : prev));
              setNote('');
            },
            placeholder: '[DSH]',
          }),
        ),

        // 审批邮件：只有接收侧在场才渲染这一块。单独装通知插件时它根本不该出现，
        // 否则用户打开一个对自己无效的开关。
        snapshot.commandAvailable
          ? h(
              'div',
              {
                style: {
                  marginBottom: 14,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.08))',
                },
              },
              h(
                'label',
                { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: form.approvalMailEnabled === true,
                  onChange: set('approvalMailEnabled'),
                }),
                t('approvalEnable'),
              ),
              h('div', { style: { ...hintStyle, marginTop: 4 } }, t('approvalHint')),
              form.approvalMailEnabled && snapshot.approvalPolicyReady === false
                ? h(
                    'div',
                    {
                      style: {
                        ...hintStyle,
                        marginTop: 8,
                        color: 'var(--dsw-alias-state-error-primary, #d4380d)',
                      },
                    },
                    t('approvalPolicyHint'),
                  )
                : null,
              form.approvalMailEnabled
                ? h(
                    Field,
                    { label: t('approvalTimeout') },
                    h('input', {
                      style: inputStyle,
                      type: 'number',
                      min: 1,
                      value: String(form.approvalMailTimeoutMs),
                      onChange: set('approvalMailTimeoutMs'),
                    }),
                  )
                : null,
            )
          : null,

        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 4, marginBottom: 12 } },
          h('button', { type: 'button', style: buttonStyle(true, busy !== ''), disabled: busy !== '', onClick: save },
            busy === 'save' ? t('saving') : t('save')),
          h('button', { type: 'button', style: buttonStyle(false, busy !== ''), disabled: busy !== '', onClick: sendTest },
            busy === 'test' ? t('testing') : t('test')),
          h('button', { type: 'button', style: buttonStyle(false, busy !== ''), disabled: busy !== '', onClick: load }, t('reload')),
        ),

        note ? h('div', { style: { fontSize: 12, marginBottom: 10, color: 'var(--dsw-alias-state-success-primary, #237804)' } }, note) : null,
        error ? h('div', { style: { fontSize: 12, marginBottom: 10, color: 'var(--dsw-alias-state-error-primary, #d4380d)' } }, error) : null,

        h(
          'div',
          { style: { marginTop: 8, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))', fontSize: 11, lineHeight: 1.9, color: 'var(--dsw-alias-label-tertiary)' } },
          h('div', null, t('fileLabel') + (snapshot.file || '—')),
          h(
            'div',
            null,
            t('sourceLabel') + ['user', 'authCode', 'to']
              .map((k) => {
                const source = sources[k];
                if (!source) return `${k}=—`;
                const key = `source_${source}`;
                const translated = t(key);
                return `${k}=${!translated || translated === key ? source : translated}`;
              })
              .join(' · '),
          ),
          h('div', null, `${t('statsLabel')}${t('sent')} ${stats.sent ?? 0} · ${t('progressSent')} ${stats.progressSent ?? 0} · ${t('failed')} ${stats.failed ?? 0} · ${t('pending')} ${stats.pending ?? 0}`),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 字典注册：语言切换由宿主统一管理，这里只提供两种语言的内容。
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-qq-mail-notify: dictionaries');
        }
        const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallback;

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-qq-mail-notify',
              order: 60,
              // 函数形式：切换界面语言后宿主会重新求值，标题才会跟着变。
              label: () => t('title'),
              inject: () => ({ t }),
            },
            SettingsPanel,
          ),
        );
      },
    };
  },
});
