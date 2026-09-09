<template>
  <div class="config-page">
    <header class="config-hero">
  <div>
    <h2>系统配置</h2>
        <p class="config-hero-desc">按模块管理 Agent 与流水线配置。保存后会更新 configVersion。</p>
      </div>
      <div class="config-version" v-if="global.configVersion">
        <span>configVersion</span>
        <strong>{{ global.configVersion }}</strong>
      </div>
    </header>

    <nav class="config-tabs" aria-label="配置分类">
      <button
        v-for="tab in configTabs"
        :key="tab.id"
        type="button"
        class="config-tab"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        <b>{{ tab.label }}</b>
        <small>{{ tab.desc }}</small>
      </button>
    </nav>

    <section v-show="activeTab === 'release'" class="config-panel">
      <AgentReleasePanel />
    </section>

    <section v-show="activeTab === 'resource'" class="config-panel">
      <ResourcePolicyPanel
        title="全局资源策略"
        description="默认作用于所有 Agent。单台设备可在「Agent 控制中心」覆盖为始终满载/限流或自定义时段。"
        :model-value="resourcePolicy"
        @save="saveResourcePolicy"
      />
    </section>

    <!-- 流水线 -->
    <section v-show="activeTab === 'pipeline'" class="config-panel">
    <div class="card">
        <h3>剪辑流水线</h3>
        <div class="card-body">
          <p class="hint">保存后更新 configVersion，Agent 拉取任务时生效。</p>

          <div class="config-section">
            <h4 class="config-section-title">渲染与本地输出</h4>
            <div class="form-check">
              <label class="form-check-label" for="llmRenderPipeline">
                <input id="llmRenderPipeline" v-model="pipeline.llmRenderPipeline" type="checkbox" class="form-check-input" />
                <span class="form-check-body">
                  <span class="form-check-title">启用方案预取</span>
                  <span class="form-check-desc">上一轮方案返回后预取下一轮选段，与当轮 FFmpeg 并行。</span>
                </span>
              </label>
            </div>
            <div class="field-grid">
              <div class="field">
                <label class="field-label" for="maxConcurrentRenders">FFmpeg 并发渲染数</label>
                <p class="field-desc">同任务同时渲染条数（资源策略生效时会被档位覆盖；见「资源策略」Tab）。</p>
                <input id="maxConcurrentRenders" v-model.number="pipeline.maxConcurrentRenders" type="number" min="1" max="8" />
              </div>
              <div class="field">
                <label class="field-label" for="maxConcurrentUploads">成片上传并发数</label>
                <p class="field-desc">开启上传后生效。</p>
                <input id="maxConcurrentUploads" v-model.number="pipeline.maxConcurrentUploads" type="number" min="1" max="8" />
              </div>
              <div class="field">
                <label class="field-label" for="maxDurationSec">单条成片最长（秒）</label>
                <p class="field-desc">超过会被校验拒绝或截断。</p>
                <input id="maxDurationSec" v-model.number="pipeline.maxDurationSec" type="number" min="120" max="1200" />
              </div>
              <div class="field">
                <label class="field-label" for="localOutputDir">本地成片目录</label>
                <p class="field-desc">关闭上传时使用，如 D:/ClipOutput。</p>
                <input id="localOutputDir" v-model="pipeline.localOutputDir" type="text" placeholder="D:/ClipOutput" />
              </div>
            </div>
            <div class="form-check">
              <label class="form-check-label" for="uploadAfterRender">
                <input id="uploadAfterRender" v-model="pipeline.uploadAfterRender" type="checkbox" class="form-check-input" />
                <span class="form-check-body">
                  <span class="form-check-title">渲染完成后上传成片</span>
                  <span class="form-check-desc">关闭时成片留在 Agent 本机；开启后上传至服务端/TOS。</span>
                </span>
              </label>
            </div>
    </div>

          <div class="config-section">
            <h4 class="config-section-title">跨集转场</h4>
            <div class="form-check">
              <label class="form-check-label" for="transitionEnabled">
                <input id="transitionEnabled" v-model="pipeline.transitionEnabled" type="checkbox" class="form-check-input" />
                <span class="form-check-body">
                  <span class="form-check-title">启用跨集转场</span>
                  <span class="form-check-desc">混剪跨集时淡入淡出/滑动，避免硬切。</span>
                </span>
              </label>
            </div>
            <div class="field-grid">
              <div class="field">
                <label class="field-label" for="transitionType">转场类型</label>
                <select id="transitionType" v-model="pipeline.transitionType" :disabled="!pipeline.transitionEnabled">
                  <option value="random">随机</option>
                  <option value="fade">淡入淡出</option>
                  <option value="dissolve">溶解</option>
                  <option value="wipeleft">向左擦除</option>
                  <option value="wiperight">向右擦除</option>
                  <option value="slideleft">向左滑动</option>
                  <option value="slideright">向右滑动</option>
                  <option value="circleopen">圆形展开</option>
                  <option value="circleclose">圆形收缩</option>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="transitionDurationSec">转场时长（秒）</label>
                <input id="transitionDurationSec" v-model.number="pipeline.transitionDurationSec" type="number" min="0.1" max="2" step="0.1" :disabled="!pipeline.transitionEnabled" />
              </div>
            </div>
          </div>

          <div class="config-section">
            <h4 class="config-section-title">TOS 上传</h4>
            <div class="form-check">
              <label class="form-check-label" for="tosEnabled">
                <input id="tosEnabled" v-model="pipeline.tosEnabled" type="checkbox" class="form-check-input" />
                <span class="form-check-body">
                  <span class="form-check-title">启用 TOS 直传</span>
                  <span class="form-check-desc">Agent 渲染完成后直接上传到火山云 TOS。</span>
                </span>
              </label>
            </div>
            <div v-if="pipeline.tosEnabled" class="tos-grid">
              <div class="field">
                <label class="field-label" for="tosEndpoint">节点地址</label>
                <input id="tosEndpoint" v-model="pipeline.tosEndpoint" placeholder="tos-cn-beijing.volces.com" />
              </div>
              <div class="field">
                <label class="field-label" for="tosBucket">Bucket</label>
                <input id="tosBucket" v-model="pipeline.tosBucket" placeholder="dclip" />
              </div>
              <div class="field">
                <label class="field-label" for="tosRegion">Region</label>
                <input id="tosRegion" v-model="pipeline.tosRegion" placeholder="cn-beijing" />
              </div>
              <div class="field">
                <label class="field-label" for="tosAccessKey">Access Key</label>
                <input id="tosAccessKey" v-model="pipeline.tosAccessKey" placeholder="AK..." />
              </div>
              <div class="field">
                <label class="field-label" for="tosAccessSecret">Access Secret</label>
                <input id="tosAccessSecret" v-model="pipeline.tosAccessSecret" type="password" placeholder="留空表示不修改" />
                <p v-if="pipeline.tosAccessSecretMasked" class="hint">当前 Secret: {{ pipeline.tosAccessSecretMasked }}</p>
              </div>
              <div class="field">
                <label class="field-label" for="tosPublicBaseUrl">公网域名 / URL 前缀</label>
                <input id="tosPublicBaseUrl" v-model="pipeline.tosPublicBaseUrl" placeholder="https://cdn.example.com" />
              </div>
              <div class="field">
                <label class="field-label" for="tosSecretEncoding">Secret 编码</label>
                <select id="tosSecretEncoding" v-model="pipeline.tosAccessSecretEncoding">
                  <option value="plain">plain（明文）</option>
                  <option value="base64">base64</option>
                </select>
              </div>
            </div>
            <div v-if="pipeline.tosEnabled" class="tos-grid">
              <div class="field">
                <label class="field-label" for="tosKeyPrefix">对象键前缀（可选）</label>
                <input id="tosKeyPrefix" v-model="pipeline.tosKeyPrefix" placeholder="留空则按默认规则生成对象键" />
              </div>
            </div>
          </div>

          <div class="dclip-actions dclip-actions--plain">
            <button class="btn" type="button" @click="savePipeline">保存流水线配置</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 成片增强 -->
    <section v-show="activeTab === 'enhance'" class="config-panel config-panel-stack">
    <div class="card">
        <h3>字幕烧录</h3>
        <div class="card-body">
          <p class="hint">ASS 字幕烧录到成片。plan.output.subtitle 为 false 时本任务不烧录。</p>
          <div class="form-check">
            <label class="form-check-label" for="subEnabled">
              <input id="subEnabled" v-model="subtitleStyle.enabled" type="checkbox" class="form-check-input" />
              <span class="form-check-body">
                <span class="form-check-title">烧录字幕</span>
                <span class="form-check-desc">成片画面直接显示台词。</span>
              </span>
            </label>
          </div>
          <div class="field-grid">
            <div class="field">
              <label class="field-label" for="subFont">字体</label>
              <select id="subFont" v-model="subtitleStyle.fontName">
                <option v-for="opt in fontOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                <option :value="CUSTOM_FONT">自定义</option>
              </select>
              <input
                v-if="subtitleStyle.fontName === CUSTOM_FONT"
                v-model="subtitleStyle.fontName"
                placeholder="输入系统已安装的字体名"
                class="custom-input"
              />
            </div>
            <div class="field">
              <label class="field-label" for="subStyle">样式模板</label>
              <select id="subStyle" v-model="subtitleStyle.style">
                <option value="standard">标准描边</option>
                <option value="glow">外发光</option>
                <option value="stroke3d">3D 立体描边</option>
                <option value="softshadow">柔阴影</option>
              </select>
              <p class="field-desc">ASS 字幕多层叠放实现，效果较柔和。</p>
            </div>
            <div class="field">
              <label class="field-label" for="subFontSize">字号（px）</label>
              <input id="subFontSize" v-model.number="subtitleStyle.fontSize" type="number" min="20" max="120" />
            </div>
            <div class="field">
              <label class="field-label" for="subAlign">垂直对齐</label>
              <select id="subAlign" v-model="subtitleStyle.alignment">
                <option value="bottom">底部</option>
                <option value="center">居中</option>
                <option value="top">顶部</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="subMarginV">底部边距</label>
              <input id="subMarginV" v-model.number="subtitleStyle.marginV" type="number" min="0" max="400" />
            </div>
            <div class="field">
              <label class="field-label" for="subOutline">描边宽度</label>
              <input id="subOutline" v-model.number="subtitleStyle.outlineWidth" type="number" min="0" max="10" step="0.5" />
            </div>
          </div>
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn" type="button" @click="savePipeline">保存字幕配置</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>背景音乐 (BGM)</h3>
        <div class="card-body">
          <p class="hint">多首候选，渲染时随机选一首。写入 <code>clip_bgm_*</code> 表，不存音频文件。</p>
          <div class="form-check">
            <label class="form-check-label" for="bgmEnabled">
              <input id="bgmEnabled" v-model="bgm.enabled" type="checkbox" class="form-check-input" />
              <span class="form-check-body">
                <span class="form-check-title">启用 BGM</span>
                <span class="form-check-desc">与台词并行混音。</span>
              </span>
            </label>
          </div>
          <div class="field-grid">
            <div class="field">
              <label class="field-label" for="bgmVolume">音量（0~1）</label>
              <input id="bgmVolume" v-model.number="bgm.volume" type="number" min="0" max="1" step="0.05" :disabled="!bgm.enabled" />
            </div>
            <div class="field">
              <label class="field-label" for="bgmFadeIn">淡入（秒）</label>
              <input id="bgmFadeIn" v-model.number="bgm.fadeInSec" type="number" min="0" max="10" step="0.5" :disabled="!bgm.enabled" />
            </div>
            <div class="field">
              <label class="field-label" for="bgmFadeOut">淡出（秒）</label>
              <input id="bgmFadeOut" v-model.number="bgm.fadeOutSec" type="number" min="0" max="10" step="0.5" :disabled="!bgm.enabled" />
            </div>
          </div>
          <div class="form-check">
            <label class="form-check-label" for="bgmLoop">
              <input id="bgmLoop" v-model="bgm.loop" type="checkbox" class="form-check-input" :disabled="!bgm.enabled" />
              <span class="form-check-body">
                <span class="form-check-title">循环到成片结束</span>
              </span>
            </label>
          </div>
          <div class="bgm-track-list" :class="{ disabled: !bgm.enabled }">
            <div v-for="(track, idx) in bgm.tracks" :key="idx" class="bgm-track-row">
              <input v-model="track.name" placeholder="名称（可选）" class="bgm-name-input" :disabled="!bgm.enabled" />
              <input v-model="track.url" placeholder="https://.../bgm.mp3" class="bgm-url-input" :disabled="!bgm.enabled" />
              <button class="btn btn-xs danger" type="button" :disabled="!bgm.enabled" @click="bgm.tracks.splice(idx, 1)">删除</button>
            </div>
            <p v-if="!bgm.tracks.length" class="hint">尚未添加 BGM。</p>
          </div>
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn secondary" type="button" :disabled="!bgm.enabled" @click="addBgmTrack">添加 BGM</button>
            <button class="btn" type="button" @click="savePipeline">保存 BGM 配置</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>标题花字</h3>
        <div class="card-body">
          <p class="hint">多个花字用于做 A/B 风格版本；默认每成片只使用一条（可切换为全部叠加）。</p>
          <div v-for="(card, idx) in titleCards" :key="idx" class="title-card-block">
            <div class="title-card-head">
              <strong>花字 {{ idx + 1 }}</strong>
              <select class="card-preset-select" @change="applyTitleCardPreset(idx, ($event.target as HTMLSelectElement).value)">
                <option value="">套用样式预设…</option>
                <option v-for="p in titleCardPresets" :key="p.id" :value="p.id">{{ p.label }}</option>
              </select>
              <button class="btn btn-xs danger" type="button" @click="titleCards.splice(idx, 1)">删除</button>
            </div>
            <div class="title-card-grid">
              <label class="field" style="grid-column: 1 / -1;"><span class="field-label">文本</span><input v-model="card.text" placeholder="花字文本；可填 ${dramaTitle} 自动替换为短剧名" /></label>
              <label class="field">
                <span class="field-label">应用模式</span>
                <select v-model="card.mode">
                  <option value="one_random">每成片只使用一条</option>
                  <option value="all">全部叠加到本条目</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">样式模板</span>
                <select v-model="card.style">
                  <option value="standard">标准描边</option>
                  <option value="bar">高对比条</option>
                  <option value="glow">外发光</option>
                  <option value="stroke3d">3D 立体描边</option>
                  <option value="vertical">竖排</option>
                </select>
              </label>
              <StylePreview :config="card" kind="title" />
              <label class="field">
                <span class="field-label">位置</span>
                <select v-model="card.position">
                  <option value="top">顶部</option>
                  <option value="center">居中</option>
                  <option value="bottom">底部</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">字体</span>
                <select v-model="card.fontName">
                  <option v-for="opt in fontOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                  <option :value="CUSTOM_FONT">自定义</option>
                </select>
                <input
                  v-if="card.fontName === CUSTOM_FONT"
                  v-model="card.fontName"
                  placeholder="输入系统已安装的字体名"
                  class="custom-input"
                />
              </label>
              <label class="field"><span class="field-label">字号</span><input v-model.number="card.fontSize" type="number" min="20" max="200" /></label>
              <label class="field">
                <span class="field-label">文字色</span>
                <input v-model="card.color" type="color" class="card-color-swatch" />
                <input v-model="card.color" placeholder="#FFD700" class="card-color-hex" />
              </label>
              <label class="field">
                <span class="field-label">描边色</span>
                <input v-model="card.outlineColor" type="color" class="card-color-swatch" />
                <input v-model="card.outlineColor" placeholder="#000000" class="card-color-hex" />
              </label>
              <label class="field"><span class="field-label">描边宽</span><input v-model.number="card.outlineWidth" type="number" min="0" max="12" step="0.5" /></label>
              <label class="field">
                <span class="field-label">背景色</span>
                <input v-model="card.backgroundColor" type="color" class="card-color-swatch" />
                <input v-model="card.backgroundColor" placeholder="#000000" class="card-color-hex" />
              </label>
              <label class="field"><span class="field-label">背景透明度</span><input v-model.number="card.backgroundAlpha" type="number" min="0" max="1" step="0.05" /></label>
              <label class="field"><span class="field-label">边距(px)</span><input v-model.number="card.marginV" type="number" min="0" max="400" /></label>
              <label class="field"><span class="field-label">字符间距(px)</span><input v-model.number="card.charSpacing" type="number" min="0" max="100" :disabled="card.style !== 'vertical'" /></label>
            </div>
          </div>
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn secondary" type="button" @click="addTitleCard">添加花字</button>
            <button class="btn" type="button" @click="savePipeline">保存花字配置</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>新增花字（WordArt）</h3>
        <div class="card-body">
          <p class="hint">新增独立配置，不修改原字幕/标题花字/角标。支持按时间段叠加多条花字，仅使用白名单可商用字体。</p>
          <div class="form-check">
            <label class="form-check-label" for="wordArtEnabled">
              <input id="wordArtEnabled" v-model="wordArt.enabled" type="checkbox" class="form-check-input" />
              <span class="form-check-body">
                <span class="form-check-title">启用新增花字</span>
                <span class="form-check-desc">开启后按下方条目在成片指定时间段渲染花字。</span>
              </span>
            </label>
          </div>
          <div class="word-art-items" :class="{ disabled: !wordArt.enabled }">
            <div v-for="(item, idx) in wordArt.items" :key="idx" class="title-card-block">
              <div class="title-card-head">
                <strong>花字条目 {{ idx + 1 }}</strong>
                <label class="line-enabled">
                  <input v-model="item.enabled" type="checkbox" :disabled="!wordArt.enabled" />
                  启用
                </label>
                <button class="btn btn-xs danger" type="button" :disabled="!wordArt.enabled" @click="wordArt.items.splice(idx, 1)">删除</button>
              </div>
              <div class="title-card-grid" :class="{ disabled: !wordArt.enabled || !item.enabled }">
                <label class="field" style="grid-column: 1 / -1;"><span class="field-label">文本</span><input v-model="item.text" placeholder="花字文本；可填 ${dramaTitle} 自动替换为短剧名" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field">
                  <span class="field-label">样式模板</span>
                  <select v-model="item.style" :disabled="!wordArt.enabled || !item.enabled">
                    <option value="standard">标准描边</option>
                    <option value="bar">高对比条</option>
                    <option value="glow">外发光</option>
                    <option value="stroke3d">3D 立体描边</option>
                    <option value="vertical">竖排</option>
                  </select>
                </label>
                <StylePreview :config="item" kind="title" />
                <label class="field">
                  <span class="field-label">字体</span>
                  <select :value="fontSelectValue(item.fontName)" :disabled="!wordArt.enabled || !item.enabled" @change="item.fontName = ($event.target as HTMLSelectElement).value === CUSTOM_FONT ? '' : ($event.target as HTMLSelectElement).value">
                    <option v-for="opt in fontOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                    <option :value="CUSTOM_FONT">自定义</option>
                  </select>
                  <input
                    v-if="fontSelectValue(item.fontName) === CUSTOM_FONT"
                    v-model="item.fontName"
                    placeholder="输入字体 family（如 DouyinSansBold）"
                    class="custom-input"
                    :disabled="!wordArt.enabled || !item.enabled"
                  />
                </label>
                <label class="field"><span class="field-label">字号</span><input v-model.number="item.fontSize" type="number" min="20" max="200" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field">
                  <span class="field-label">文字色</span>
                  <input v-model="item.color" type="color" class="card-color-swatch" :disabled="!wordArt.enabled || !item.enabled" />
                  <input v-model="item.color" placeholder="#FFD700" class="card-color-hex" :disabled="!wordArt.enabled || !item.enabled" />
                </label>
                <label class="field">
                  <span class="field-label">描边色</span>
                  <input v-model="item.outlineColor" type="color" class="card-color-swatch" :disabled="!wordArt.enabled || !item.enabled" />
                  <input v-model="item.outlineColor" placeholder="#000000" class="card-color-hex" :disabled="!wordArt.enabled || !item.enabled" />
                </label>
                <label class="field"><span class="field-label">描边宽</span><input v-model.number="item.outlineWidth" type="number" min="0" max="12" step="0.5" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field">
                  <span class="field-label">背景色</span>
                  <input v-model="item.backgroundColor" type="color" class="card-color-swatch" :disabled="!wordArt.enabled || !item.enabled" />
                  <input v-model="item.backgroundColor" placeholder="#000000" class="card-color-hex" :disabled="!wordArt.enabled || !item.enabled" />
                </label>
                <label class="field"><span class="field-label">背景透明度</span><input v-model.number="item.backgroundAlpha" type="number" min="0" max="1" step="0.05" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field">
                  <span class="field-label">位置</span>
                  <select v-model="item.position" :disabled="!wordArt.enabled || !item.enabled">
                    <option value="top">顶部</option>
                    <option value="center">居中</option>
                    <option value="bottom">底部</option>
                  </select>
                </label>
                <label class="field"><span class="field-label">出现时间（秒）</span><input v-model.number="item.startSec" type="number" min="0" step="0.1" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field"><span class="field-label">结束时间（秒）</span><input v-model.number="item.endSec" type="number" min="0" step="0.1" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field"><span class="field-label">垂直边距(px)</span><input v-model.number="item.marginV" type="number" min="0" max="400" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field"><span class="field-label">字符间距(px)</span><input v-model.number="item.charSpacing" type="number" min="0" max="100" :disabled="!wordArt.enabled || !item.enabled || item.style !== 'vertical'" /></label>
                <label class="field"><span class="field-label">整剧出现比例（0~1）</span><input v-model.number="item.appearanceRatio" type="number" min="0" max="1" step="0.05" :disabled="!wordArt.enabled || !item.enabled" /></label>
                <label class="field">
                  <span class="field-label">发光色</span>
                  <input v-model="item.glowColor" type="color" class="card-color-swatch" :disabled="!wordArt.enabled || !item.enabled" />
                  <input v-model="item.glowColor" placeholder="#FFFFFF" class="card-color-hex" :disabled="!wordArt.enabled || !item.enabled" />
                </label>
                <label class="field">
                  <span class="field-label">阴影色</span>
                  <input v-model="item.shadowColor" type="color" class="card-color-swatch" :disabled="!wordArt.enabled || !item.enabled" />
                  <input v-model="item.shadowColor" placeholder="#000000" class="card-color-hex" :disabled="!wordArt.enabled || !item.enabled" />
                </label>
              </div>
            </div>
          </div>
          <p v-if="!wordArt.items.length" class="hint" :class="{ disabled: !wordArt.enabled }">尚未添加花字条目。</p>
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn secondary" type="button" :disabled="!wordArt.enabled" @click="addWordArtItem">添加花字条目</button>
            <button class="btn" type="button" @click="savePipeline">保存新增花字配置</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>贴花 / 花字模板（Stickers）</h3>
        <div class="card-body">
          <p class="hint">新增独立配置，不改动原字幕/标题花字/角标。支持手动叠加和按场景自动匹配。素材需放入 Agent 的 assets/stickers/ 目录并在 stickers.json 中登记。</p>
          <div class="form-check">
            <label class="form-check-label" for="stickersEnabled">
              <input id="stickersEnabled" v-model="stickers.enabled" type="checkbox" class="form-check-input" />
              <span class="form-check-body">
                <span class="form-check-title">启用贴花/花字模板</span>
                <span class="form-check-desc">开启后按下方手动条目或自动匹配规则在成片叠加贴花。</span>
              </span>
            </label>
          </div>
          <div class="word-art-items" :class="{ disabled: !stickers.enabled }">
            <div class="config-section">
              <h4 class="config-section-title">自动匹配</h4>
              <div class="form-check">
                <label class="form-check-label" for="stickersAutoEnabled">
                  <input id="stickersAutoEnabled" v-model="stickers.autoMatch.enabled" type="checkbox" :disabled="!stickers.enabled" class="form-check-input" />
                  <span class="form-check-body">
                    <span class="form-check-title">按场景自动匹配</span>
                    <span class="form-check-desc">根据 ASR 高光类型（hook/conflict/twist/cliff/cta）和场景标签自动选择模板。</span>
                  </span>
                </label>
              </div>
              <div class="field-grid">
                <label class="field"><span class="field-label">最多自动叠加条数</span><input v-model.number="stickers.autoMatch.maxOverlays" type="number" min="0" max="10" :disabled="!stickers.enabled || !stickers.autoMatch.enabled" /></label>
                <label class="field">
                  <span class="field-label">回退默认模板</span>
                  <select v-model="stickers.autoMatch.defaultTemplateId" :disabled="!stickers.enabled || !stickers.autoMatch.enabled">
                    <option value="">不指定</option>
                    <option v-for="t in stickerTemplates" :key="t.id" :value="t.id">{{ t.name }}</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">仅匹配高光类型</span>
                  <select v-model="stickers.autoMatch.matchHighlightTypes" multiple :disabled="!stickers.enabled || !stickers.autoMatch.enabled" class="multi-select">
                    <option value="hook">钩子/引流</option>
                    <option value="conflict">冲突</option>
                    <option value="twist">反转</option>
                    <option value="cliff">悬念</option>
                  </select>
                </label>
              </div>
            </div>

            <div class="config-section">
              <h4 class="config-section-title">手动叠加条目</h4>
              <div v-for="(item, idx) in stickers.overlays" :key="idx" class="title-card-block">
                <div class="title-card-head">
                  <strong>贴花条目 {{ idx + 1 }}</strong>
                  <label class="line-enabled">
                    <input v-model="item.enabled" type="checkbox" :disabled="!stickers.enabled" />
                    启用
                  </label>
                  <button class="btn btn-xs danger" type="button" :disabled="!stickers.enabled" @click="stickers.overlays.splice(idx, 1)">删除</button>
                </div>
                <div class="title-card-grid" :class="{ disabled: !stickers.enabled || !item.enabled }">
                  <label class="field" style="grid-column: 1 / -1;">
                    <span class="field-label">模板</span>
                    <select v-model="item.templateId" :disabled="!stickers.enabled || !item.enabled">
                      <option value="">请选择模板</option>
                      <option v-for="t in stickerTemplates" :key="t.id" :value="t.id">{{ t.name }}</option>
                    </select>
                  </label>
                  <label class="field" v-if="selectedStickerTemplate(item.templateId)?.textPlaceholder">
                    <span class="field-label">文字替换（{{ selectedStickerTemplate(item.templateId)?.textPlaceholder }}）</span>
                    <input v-model="item.text" :disabled="!stickers.enabled || !item.enabled" placeholder="可填 ${dramaTitle}" />
                  </label>
                  <label class="field">
                    <span class="field-label">位置</span>
                    <select v-model="item.position" :disabled="!stickers.enabled || !item.enabled">
                      <option value="top-left">左上</option>
                      <option value="top">顶部居中</option>
                      <option value="top-right">右上</option>
                      <option value="center-left">左中</option>
                      <option value="center">居中</option>
                      <option value="center-right">右中</option>
                      <option value="bottom-left">左下</option>
                      <option value="bottom">底部居中</option>
                      <option value="bottom-right">右下</option>
                    </select>
                  </label>
                  <label class="field"><span class="field-label">开始时间（秒）</span><input v-model.number="item.startSec" type="number" min="0" step="0.1" :disabled="!stickers.enabled || !item.enabled" /></label>
                  <label class="field"><span class="field-label">结束时间（秒）</span><input v-model.number="item.endSec" type="number" min="0" step="0.1" :disabled="!stickers.enabled || !item.enabled" /></label>
                  <label class="field"><span class="field-label">缩放</span><input v-model.number="item.scale" type="number" min="0.01" max="10" step="0.05" :disabled="!stickers.enabled || !item.enabled" /></label>
                  <label class="field"><span class="field-label">水平偏移（px）</span><input v-model.number="item.offsetX" type="number" step="1" :disabled="!stickers.enabled || !item.enabled" /></label>
                  <label class="field"><span class="field-label">垂直偏移（px）</span><input v-model.number="item.offsetY" type="number" step="1" :disabled="!stickers.enabled || !item.enabled" /></label>
                  <label class="field"><span class="field-label">旋转角度（度）</span><input v-model.number="item.rotation" type="number" min="-180" max="180" step="1" :disabled="!stickers.enabled || !item.enabled" /></label>
                  <label class="field"><span class="field-label">透明度（0~1）</span><input v-model.number="item.alpha" type="number" min="0" max="1" step="0.05" :disabled="!stickers.enabled || !item.enabled" /></label>
                  <label class="field">
                    <span class="field-label">循环播放</span>
                    <select v-model="item.loop" :disabled="!stickers.enabled || !item.enabled">
                      <option :value="true">是</option>
                      <option :value="false">否</option>
                    </select>
                  </label>
                  <label class="field" style="grid-column: 1 / -1;">
                    <span class="field-label">匹配标签（仅在包含这些标签的片段上叠加，逗号分隔）</span>
                    <input v-model="item.matchTagsText" :disabled="!stickers.enabled || !item.enabled" placeholder="hook,conflict,twist,cliff,cta,romance,ancient,revenge" />
                  </label>
                  <label class="field" style="grid-column: 1 / -1;">
                    <span class="field-label">匹配高光类型（逗号分隔）</span>
                    <input v-model="item.matchHighlightTypesText" :disabled="!stickers.enabled || !item.enabled" placeholder="hook,conflict,twist,cliff" />
                  </label>
                </div>
              </div>
              <p v-if="!stickers.overlays.length" class="hint" :class="{ disabled: !stickers.enabled }">尚未添加手动叠加条目。</p>
            </div>
          </div>
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn secondary" type="button" :disabled="!stickers.enabled" @click="addStickerOverlay">添加贴花条目</button>
            <button class="btn" type="button" @click="savePipeline">保存贴花配置</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>免责声明 / 剧集提示条</h3>
        <div class="card-body">
          <div class="form-check">
            <label class="form-check-label" for="disclaimerEnabled">
              <input id="disclaimerEnabled" v-model="disclaimer.enabled" type="checkbox" class="form-check-input" />
              <span class="form-check-body">
                <span class="form-check-title">启用免责声明</span>
                <span class="form-check-desc">在成片上下左右某一侧居中叠加提示文案，多个条目默认每成片只使用一条。</span>
              </span>
            </label>
          </div>
          <div class="disclaimer-lines" :class="{ disabled: !disclaimer.enabled }">
            <div class="disclaimer-defaults">
              <label class="field"><span class="field-label">默认文案合集</span><textarea v-model="disclaimer.defaultLines" rows="4" placeholder="热门短剧 影视效果 请勿模仿（一行一条）" :disabled="!disclaimer.enabled" /></label>
              <label class="field">
                <span class="field-label">应用模式</span>
                <select v-model="disclaimer.mode" :disabled="!disclaimer.enabled">
                  <option value="one_random">每成片只使用一条</option>
                  <option value="round_robin">按输出序号轮询</option>
                  <option value="all">全部叠加</option>
                </select>
              </label>
            </div>
            <div v-for="(line, idx) in disclaimer.lines" :key="idx" class="disclaimer-line-block">
              <div class="disclaimer-line-head">
                <strong>提示条 {{ idx + 1 }}</strong>
                <label class="line-enabled">
                  <input v-model="line.enabled" type="checkbox" :disabled="!disclaimer.enabled" />
                  启用
                </label>
                <button class="btn btn-xs danger" type="button" @click="disclaimer.lines.splice(idx, 1)">删除</button>
              </div>
              <div class="disclaimer-line-grid">
                <label class="field"><span class="field-label">文案</span><input v-model="line.text" placeholder="为空时按默认合集轮询" :disabled="!disclaimer.enabled || !line.enabled" /></label>
                <label class="field">
                  <span class="field-label">位置</span>
                  <select v-model="line.position" :disabled="!disclaimer.enabled || !line.enabled">
                    <option value="top">顶部</option>
                    <option value="bottom">底部</option>
                    <option value="left">左侧</option>
                    <option value="right">右侧</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">样式模板</span>
                  <select v-model="line.style" :disabled="!disclaimer.enabled || !line.enabled">
                    <option value="standard">标准描边</option>
                    <option value="bar">高对比条</option>
                    <option value="glow">外发光</option>
                    <option value="vertical">竖排</option>
                  </select>
                </label>
                <StylePreview :config="line" kind="disclaimer" />
                <label class="field">
                  <span class="field-label">字体</span>
                  <select v-model="line.fontName" :disabled="!disclaimer.enabled || !line.enabled">
                    <option v-for="opt in fontOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                    <option :value="CUSTOM_FONT">自定义</option>
                  </select>
                  <input
                    v-if="line.fontName === CUSTOM_FONT"
                    v-model="line.fontName"
                    placeholder="输入系统已安装的字体名"
                    class="custom-input"
                    :disabled="!disclaimer.enabled || !line.enabled"
                  />
                </label>
                <label class="field"><span class="field-label">字号</span><input v-model.number="line.fontSize" type="number" min="12" max="120" :disabled="!disclaimer.enabled || !line.enabled" /></label>
                <label class="field">
                  <span class="field-label">文字色</span>
                  <input v-model="line.color" type="color" class="card-color-swatch" :disabled="!disclaimer.enabled || !line.enabled" />
                  <input v-model="line.color" placeholder="#FFFFFF" class="card-color-hex" :disabled="!disclaimer.enabled || !line.enabled" />
                </label>
                <label class="field">
                  <span class="field-label">描边色</span>
                  <input v-model="line.outlineColor" type="color" class="card-color-swatch" :disabled="!disclaimer.enabled || !line.enabled" />
                  <input v-model="line.outlineColor" placeholder="#000000" class="card-color-hex" :disabled="!disclaimer.enabled || !line.enabled" />
                </label>
                <label class="field"><span class="field-label">描边宽</span><input v-model.number="line.outlineWidth" type="number" min="0" max="12" step="0.5" :disabled="!disclaimer.enabled || !line.enabled" /></label>
                <label class="field"><span class="field-label">边距(px)</span><input v-model.number="line.margin" type="number" min="0" max="400" :disabled="!disclaimer.enabled || !line.enabled" /></label>
                <label class="field"><span class="field-label">字符间距(px)</span><input v-model.number="line.charSpacing" type="number" min="0" max="100" :disabled="!disclaimer.enabled || !line.enabled || (line.position !== 'left' && line.position !== 'right')" /></label>
                <label class="field">
                  <span class="field-label">背景色</span>
                  <input v-model="line.backgroundColor" type="color" class="card-color-swatch" :disabled="!disclaimer.enabled || !line.enabled" />
                  <input v-model="line.backgroundColor" placeholder="#000000" class="card-color-hex" :disabled="!disclaimer.enabled || !line.enabled" />
                </label>
                <label class="field"><span class="field-label">背景透明度</span><input v-model.number="line.backgroundAlpha" type="number" min="0" max="1" step="0.05" :disabled="!disclaimer.enabled || !line.enabled" /></label>
              </div>
            </div>
          </div>
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn secondary" type="button" @click="addDisclaimerLine">添加提示条</button>
            <button class="btn" type="button" @click="savePipeline">保存免责声明配置</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>角标</h3>
        <div class="card-body">
          <p class="hint">支持配置多个角标，每个角标可独立选择位置、样式和文案。位置留空则默认右上角。</p>
          <div v-for="(wm, idx) in cornerWatermarks" :key="idx" class="disclaimer-line-block">
            <div class="disclaimer-line-head">
              <strong>角标 {{ idx + 1 }}</strong>
              <label class="line-enabled">
                <input v-model="wm.enabled" type="checkbox" />
                启用
              </label>
              <button class="btn btn-xs danger" type="button" @click="removeCornerWatermark(idx)">删除</button>
            </div>
            <div class="field-grid" :class="{ disabled: !wm.enabled }">
              <label class="field" style="grid-column: 1 / -1;">
                <span class="field-label">文案</span>
                <input v-model="wm.text" placeholder="如：热门短剧" :disabled="!wm.enabled" />
              </label>
              <label class="field">
                <span class="field-label">位置</span>
                <select v-model="wm.position" :disabled="!wm.enabled">
                  <option value="top-left">左上</option>
                  <option value="top-right">右上</option>
                  <option value="center-left">左中</option>
                  <option value="center-right">右中</option>
                  <option value="bottom-left">左下</option>
                  <option value="bottom-right">右下</option>
                </select>
              </label>
                <label class="field">
                  <span class="field-label">样式模板</span>
                  <select v-model="wm.style" :disabled="!wm.enabled">
                    <option value="standard">标准描边花字</option>
                    <option value="glow">外发光花字</option>
                    <option value="stroke3d">3D 立体描边花字</option>
                    <option value="ribbon">丝带花字</option>
                    <option value="tape">胶带花字</option>
                    <option value="badge">徽章花字</option>
                    <option value="flag">旗帜花字</option>
                    <option value="pulsing">呼吸闪烁花字</option>
                    <option value="none">不显示</option>
                  </select>
                </label>
                <StylePreview :config="wm" kind="corner" />
              <label class="field">
                <span class="field-label">应用模式</span>
                <select v-model="wm.mode" :disabled="!wm.enabled">
                  <option value="all">全部成片</option>
                  <option value="random">随机部分</option>
                  <option value="none">不应用</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">随机概率</span>
                <input v-model.number="wm.randomRatio" type="number" min="0" max="1" step="0.05" :disabled="!wm.enabled || wm.mode !== 'random'" />
              </label>
              <label class="field">
                <span class="field-label">字体</span>
                <select v-model="wm.fontName" :disabled="!wm.enabled">
                  <option v-for="opt in fontOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                  <option :value="CUSTOM_FONT">自定义</option>
                </select>
                <input
                  v-if="fontSelectValue(wm.fontName) === CUSTOM_FONT"
                  v-model="wm.fontName"
                  placeholder="输入系统已安装的字体名"
                  class="custom-input"
                  :disabled="!wm.enabled"
                />
              </label>
              <label class="field"><span class="field-label">字号</span><input v-model.number="wm.fontSize" type="number" min="12" max="120" :disabled="!wm.enabled" /></label>
              <label class="field">
                <span class="field-label">文字色</span>
                <input v-model="wm.color" type="color" class="card-color-swatch" :disabled="!wm.enabled" />
                <input v-model="wm.color" placeholder="#FFFFFF" class="card-color-hex" :disabled="!wm.enabled" />
              </label>
              <label class="field">
                <span class="field-label">描边色</span>
                <input v-model="wm.outlineColor" type="color" class="card-color-swatch" :disabled="!wm.enabled" />
                <input v-model="wm.outlineColor" placeholder="#000000" class="card-color-hex" :disabled="!wm.enabled" />
              </label>
              <label class="field"><span class="field-label">描边宽</span><input v-model.number="wm.outlineWidth" type="number" min="0" max="12" step="0.5" :disabled="!wm.enabled" /></label>
              <label class="field">
                <span class="field-label">背景色</span>
                <input v-model="wm.backgroundColor" type="color" class="card-color-swatch" :disabled="!wm.enabled" />
                <input v-model="wm.backgroundColor" placeholder="#FF0000" class="card-color-hex" :disabled="!wm.enabled" />
              </label>
              <label class="field"><span class="field-label">背景透明度</span><input v-model.number="wm.backgroundAlpha" type="number" min="0" max="1" step="0.05" :disabled="!wm.enabled" /></label>
              <label class="field"><span class="field-label">边距(px)</span><input v-model.number="wm.margin" type="number" min="0" max="400" :disabled="!wm.enabled" /></label>
              <label class="field"><span class="field-label">旋转角度</span><input v-model.number="wm.rotation" type="number" min="-180" max="180" :disabled="!wm.enabled" /></label>
            </div>
          </div>
          <div class="form-actions">
            <button class="btn secondary" type="button" @click="addCornerWatermark">添加角标</button>
          </div>
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn" type="button" @click="savePipeline">保存角标配置</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 高级 -->
    <section v-show="activeTab === 'advanced'" class="config-panel">
    <div class="card">
        <h3>渲染参数 JSON</h3>
        <div class="card-body">
          <p class="hint">编码器等高级项。日常请用上方各 Tab 表单，避免直接改 JSON 搞乱结构。</p>
          <textarea v-model="renderJson" rows="14" class="prompt-area" />
          <div class="dclip-actions dclip-actions--plain">
            <button class="btn" type="button" @click="saveRender">保存渲染 JSON</button>
      </div>
    </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { api } from "../api";

import AgentReleasePanel from "../components/AgentReleasePanel.vue";
import ResourcePolicyPanel, { type ResourcePolicyForm } from "../components/ResourcePolicyPanel.vue";
import StylePreview from "../components/StylePreview.vue";

type ConfigTab =
  | "release"
  | "resource"
  | "pipeline"
  | "enhance"
  | "advanced";

const route = useRoute();
const router = useRouter();

const CONFIG_TABS: ConfigTab[] = [
  "release",
  "resource",
  "pipeline",
  "enhance",
  "advanced",
];

function tabFromRouteQuery(): ConfigTab {
  const raw = String(route.query.tab ?? "");
  return (CONFIG_TABS.includes(raw as ConfigTab) ? raw : "pipeline") as ConfigTab;
}

const activeTab = ref<ConfigTab>(tabFromRouteQuery());
const configTabs: Array<{ id: ConfigTab; label: string; desc: string }> = [
  { id: "release", label: "版本发布", desc: "Agent 客户端更新" },
  { id: "resource", label: "资源策略", desc: "工作时段限流" },
  { id: "pipeline", label: "流水线", desc: "并发、上传、TOS" },
  { id: "enhance", label: "成片增强", desc: "字幕、BGM、花字" },
  { id: "advanced", label: "高级", desc: "渲染 JSON" },
];

watch(
  () => route.query.tab,
  () => {
    activeTab.value = tabFromRouteQuery();
  },
);

watch(activeTab, (id) => {
  const current = String(route.query.tab ?? "pipeline");
  if (current === id) return;
  void router.replace({
    path: "/config",
    query: id === "pipeline" ? {} : { tab: id },
  });
});

const resourcePolicy = ref<Partial<ResourcePolicyForm> | null>(null);

const global = ref<Record<string, unknown>>({});
const renderJson = ref("{}");
const pipeline = reactive({
  llmRenderPipeline: true,
  maxConcurrentRenders: 2,
  maxConcurrentUploads: 2,
  maxDurationSec: 1200,
  uploadAfterRender: false,
  localOutputDir: "D:/ClipOutput",
  transitionEnabled: false,
  transitionType: "random",
  transitionDurationSec: 0.5,
  tosEnabled: false,
  tosEndpoint: "",
  tosBucket: "",
  tosRegion: "cn-beijing",
  tosAccessKey: "",
  tosAccessSecret: "",
  tosAccessSecretMasked: "",
  tosAccessSecretEncoding: "base64" as "plain" | "base64",
  tosKeyPrefix: "",
  tosPublicBaseUrl: "",
});
const subtitleStyle = reactive({
  enabled: true,
  fontName: "Microsoft YaHei",
  fontSize: 48,
  primaryColor: "&H00FFFFFF",
  outlineColor: "&H00000000",
  outlineWidth: 2,
  marginV: 80,
  alignment: "bottom" as "bottom" | "center" | "top",
  style: "standard" as "standard" | "glow" | "stroke3d" | "softshadow",
});
const bgm = reactive({
  enabled: false,
  volume: 0.25,
  fadeInSec: 1,
  fadeOutSec: 2,
  loop: true,
  tracks: [] as Array<{ name: string; url: string }>,
});
/** 渲染端（Windows Agent）系统字体备选；作为兜底保留，优先加载白名单可商用字体 */
const SYSTEM_FONT_OPTIONS = [
  { value: "Microsoft YaHei", label: "Microsoft YaHei（微软雅黑）" },
  { value: "SimHei", label: "SimHei（黑体）" },
  { value: "SimSun", label: "SimSun（宋体）" },
  { value: "SimKai", label: "SimKai（楷体）" },
  { value: "FangSong", label: "FangSong（仿宋）" },
  { value: "DengXian", label: "DengXian（等线）" },
  { value: "Microsoft JhengHei", label: "Microsoft JhengHei（微软正黑体）" },
  { value: "Noto Sans SC", label: "Noto Sans SC" },
  { value: "Noto Serif SC", label: "Noto Serif SC" },
  { value: "Arial", label: "Arial" },
  { value: "HYZhongHeiTi", label: "HYZhongHeiTi（汉仪中黑体）" },
];
const CUSTOM_FONT = "__custom__";

/** 字体下拉选项：优先从 /admin/api/fonts 加载白名单可商用字体，再保留系统字体备选 */
const fontOptions = ref<Array<{ value: string; label: string; source?: string; license?: string; licenseScope?: string }>>([
  ...SYSTEM_FONT_OPTIONS,
]);
const whitelistFontFamilies = ref<string[]>([]);

/** 字体 family → 字体文件下载 URL 映射（仅白名单字体有值），用于预览真实加载 */
const fontUrlMap = ref<Record<string, string>>({});

function injectPreviewFontFaces(fonts: Array<{ value: string; fileUrl?: string }>) {
  const styleId = "admin-preview-font-faces";
  let styleTag = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = styleId;
    styleTag.type = "text/css";
    document.head.appendChild(styleTag);
  }
  const rules = fonts
    .filter((f) => f.fileUrl)
    .map((f) => `@font-face { font-family: "${f.value}"; src: url("${f.fileUrl}"); font-display: swap; }`)
    .join("\n");
  styleTag.textContent = rules;
}

async function loadFonts() {
  try {
    const data = await api.listFonts();
    whitelistFontFamilies.value = data.whitelist.map((f) => f.value);
    const map: Record<string, string> = {};
    for (const f of data.whitelist) {
      if (f.fileUrl) map[f.value] = f.fileUrl;
    }
    fontUrlMap.value = map;
    injectPreviewFontFaces(data.whitelist);
    const whitelist = data.whitelist.map((f) => ({
      value: f.value,
      label: f.label,
      source: "whitelist" as const,
      license: f.license,
      licenseScope: f.licenseScope,
    }));
    const system = (data.systemFallbacks ?? []).map((f) => ({ ...f, source: "system" as const }));
    // 白名单在前，系统备选在后，便于优先选择可商用字体
    fontOptions.value = [...whitelist, ...system];
  } catch (err) {
    console.warn("加载字体清单失败:", err);
    fontOptions.value = [...SYSTEM_FONT_OPTIONS];
    whitelistFontFamilies.value = [];
    fontUrlMap.value = {};
  }
}

function isCustomFont(fontName: string): boolean {
  return !fontOptions.value.some((o) => o.value === fontName);
}

function fontSelectValue(fontName: string, customValue = CUSTOM_FONT): string {
  return isCustomFont(fontName) ? customValue : fontName;
}

const titleCards = reactive<Array<Record<string, unknown>>>([]);
const disclaimer = reactive({
  enabled: false,
  defaultLines: "热门短剧 影视效果 请勿模仿\n本故事纯属虚构 请树立正确价值观\n热门短剧 剧情虚构 无不良引导\n热门短剧 本故事纯属虚构\n剧情纯属虚构 请勿模仿\n剧情演绎纯属虚构 爆款短剧 正在热播",
  mode: "one_random" as "one_random" | "round_robin" | "all",
  lines: [] as Array<Record<string, unknown>>,
});
const cornerWatermarks = reactive<Array<Record<string, unknown>>>([]);
const cornerWatermark = reactive<Record<string, unknown>>(makeEmptyCornerWatermark());
const wordArt = reactive({
  enabled: false,
  items: [] as Array<Record<string, unknown>>,
});

function makeEmptyWordArtItem(): Record<string, unknown> {
  return {
    enabled: true,
    text: "",
    style: "standard",
    fontName: "DouyinSansBold",
    fontSize: 64,
    color: "#FFD700",
    outlineColor: "#000000",
    outlineWidth: 3,
    backgroundColor: "#000000",
    backgroundAlpha: 0.35,
    position: "top",
    marginV: 60,
    startSec: 0,
    endSec: 5,
    charSpacing: 4,
    glowColor: "#FFFFFF",
    shadowColor: "#000000",
    appearanceRatio: 1,
  };
}

function addWordArtItem() {
  wordArt.items.push(makeEmptyWordArtItem());
}

function applyWordArtFromRender(render: Record<string, unknown> | undefined) {
  const wa = (render?.wordArt ?? {}) as Record<string, unknown>;
  wordArt.enabled = wa.enabled === true;
  const incomingItems = Array.isArray(wa.items) ? wa.items : [];
  wordArt.items.splice(
    0,
    wordArt.items.length,
    ...incomingItems.map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        enabled: item.enabled !== false,
        text: String(item.text ?? ""),
        style: (["standard", "bar", "glow", "stroke3d", "vertical"].includes(String(item.style))
          ? item.style
          : "standard") as "standard" | "bar" | "glow" | "stroke3d" | "vertical",
        fontName: String(item.fontName ?? "DouyinSansBold"),
        fontSize: Math.max(12, Math.min(200, Number(item.fontSize ?? 64))),
        color: normalizeHexColor(String(item.color ?? "#FFD700"), "#FFD700"),
        outlineColor: normalizeHexColor(String(item.outlineColor ?? "#000000"), "#000000"),
        outlineWidth: Number(item.outlineWidth ?? 3),
        backgroundColor: normalizeHexColor(String(item.backgroundColor ?? "#000000"), "#000000"),
        backgroundAlpha: Math.max(0, Math.min(1, Number(item.backgroundAlpha ?? 0.35))),
        position: (["top", "center", "bottom"].includes(String(item.position))
          ? item.position
          : "top") as "top" | "center" | "bottom",
        marginV: Number(item.marginV ?? 60),
        startSec: Number(item.startSec ?? 0),
        endSec: Number(item.endSec ?? 5),
        charSpacing: Number(item.charSpacing ?? 4),
        glowColor: normalizeHexColor(String(item.glowColor ?? "#FFFFFF"), "#FFFFFF"),
        shadowColor: normalizeHexColor(String(item.shadowColor ?? "#000000"), "#000000"),
        appearanceRatio: Math.max(0, Math.min(1, Number(item.appearanceRatio ?? 1))),
      };
    }),
  );
}

function mergeWordArtIntoRender(): { wordArt: Record<string, unknown> } {
  return {
    wordArt: {
      enabled: wordArt.enabled === true,
      items: wordArt.items
        .filter((item) => item.enabled !== false)
        .map((item) => ({
          enabled: item.enabled !== false,
          text: String(item.text ?? "").trim() || undefined,
          style: item.style ?? "standard",
          fontName: String(item.fontName ?? "DouyinSansBold").trim() || undefined,
          fontSize: Number(item.fontSize ?? 64),
          color: normalizeHexColor(String(item.color ?? "#FFD700"), "#FFD700"),
          outlineColor: normalizeHexColor(String(item.outlineColor ?? "#000000"), "#000000"),
          outlineWidth: Number(item.outlineWidth ?? 3),
          backgroundColor: normalizeHexColor(String(item.backgroundColor ?? "#000000"), "#000000"),
          backgroundAlpha: Math.max(0, Math.min(1, Number(item.backgroundAlpha ?? 0.35))),
          position: (["top", "center", "bottom"].includes(String(item.position)) ? item.position : "top") as "top" | "center" | "bottom",
          marginV: Number(item.marginV ?? 60),
          startSec: Number(item.startSec ?? 0),
          endSec: Number(item.endSec ?? 5),
          charSpacing: Number(item.charSpacing ?? 4),
          glowColor: normalizeHexColor(String(item.glowColor ?? "#FFFFFF"), "#FFFFFF"),
          shadowColor: normalizeHexColor(String(item.shadowColor ?? "#000000"), "#000000"),
          appearanceRatio: Math.max(0, Math.min(1, Number(item.appearanceRatio ?? 1))),
        })),
    },
  };
}

interface StickerTemplateAdmin {
  id: string;
  name: string;
  type: string;
  file: string;
  categories?: string[];
  tags?: string[];
  defaultPosition?: string;
  defaultScale?: number;
  durationSec?: number;
  loop?: boolean;
  textPlaceholder?: string | null;
  license?: string;
  licenseScope?: string;
}

const stickerTemplates = ref<StickerTemplateAdmin[]>([]);

const stickers = reactive({
  enabled: false,
  autoMatch: {
    enabled: false,
    maxOverlays: 3,
    defaultTemplateId: "",
    matchHighlightTypes: [] as string[],
  },
  overlays: [] as Array<Record<string, unknown>>,
});

function makeEmptyStickerOverlay(): Record<string, unknown> {
  return {
    enabled: true,
    templateId: "",
    position: "center",
    scale: 0.5,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    alpha: 1,
    loop: true,
    startSec: 0,
    endSec: 3,
    text: "",
    matchTagsText: "",
    matchHighlightTypesText: "",
  };
}

function addStickerOverlay() {
  stickers.overlays.push(makeEmptyStickerOverlay());
}

function selectedStickerTemplate(templateId: string): StickerTemplateAdmin | undefined {
  return stickerTemplates.value.find((t) => t.id === templateId);
}

function applyStickersFromRender(render: Record<string, unknown> | undefined) {
  const s = (render?.stickers ?? {}) as Record<string, unknown>;
  stickers.enabled = s.enabled === true;
  const auto = (s.autoMatch ?? {}) as Record<string, unknown>;
  stickers.autoMatch.enabled = auto.enabled === true;
  stickers.autoMatch.maxOverlays = Math.max(0, Math.min(10, Number(auto.maxOverlays ?? 3)));
  stickers.autoMatch.defaultTemplateId = String(auto.defaultTemplateId ?? "");
  const rawMatchHighlightTypes = Array.isArray(auto.matchHighlightTypes) ? auto.matchHighlightTypes : [];
  stickers.autoMatch.matchHighlightTypes = rawMatchHighlightTypes.filter((t): t is string => typeof t === "string");

  const incomingOverlays = Array.isArray(s.overlays) ? s.overlays : [];
  stickers.overlays.splice(
    0,
    stickers.overlays.length,
    ...incomingOverlays.map((raw) => {
      const item = raw as Record<string, unknown>;
      const validPositions = ["top-left", "top", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom", "bottom-right"];
      const matchTags = Array.isArray(item.matchTags)
        ? item.matchTags.filter((t): t is string => typeof t === "string")
        : [];
      const matchHighlightTypes = Array.isArray(item.matchHighlightTypes)
        ? item.matchHighlightTypes.filter((t): t is string => typeof t === "string")
        : [];
      return {
        enabled: item.enabled !== false,
        templateId: String(item.templateId ?? ""),
        position: validPositions.includes(String(item.position)) ? String(item.position) : "center",
        scale: Math.max(0.01, Math.min(10, Number(item.scale ?? 0.5))),
        offsetX: Number(item.offsetX ?? 0),
        offsetY: Number(item.offsetY ?? 0),
        rotation: Number(item.rotation ?? 0),
        alpha: Math.max(0, Math.min(1, Number(item.alpha ?? 1))),
        loop: item.loop !== false,
        startSec: Number(item.startSec ?? 0),
        endSec: Number(item.endSec ?? 3),
        text: String(item.text ?? ""),
        matchTagsText: matchTags.join(","),
        matchHighlightTypesText: matchHighlightTypes.join(","),
      };
    }),
  );
}

function mergeStickersIntoRender(): { stickers: Record<string, unknown> } {
  const validPositions = ["top-left", "top", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom", "bottom-right"];
  return {
    stickers: {
      enabled: stickers.enabled === true,
      autoMatch: {
        enabled: stickers.autoMatch.enabled === true,
        maxOverlays: Math.max(0, Math.min(10, Number(stickers.autoMatch.maxOverlays ?? 3))),
        defaultTemplateId: stickers.autoMatch.defaultTemplateId?.trim() || undefined,
        matchHighlightTypes: stickers.autoMatch.matchHighlightTypes.filter((t): t is string => typeof t === "string" && t.trim() !== ""),
      },
      overlays: stickers.overlays
        .filter((item) => item.enabled !== false && String(item.templateId ?? "").trim() !== "")
        .map((item) => ({
          enabled: item.enabled !== false,
          templateId: String(item.templateId ?? "").trim(),
          position: validPositions.includes(String(item.position)) ? String(item.position) : "center",
          scale: Math.max(0.01, Math.min(10, Number(item.scale ?? 0.5))),
          offsetX: Number(item.offsetX ?? 0),
          offsetY: Number(item.offsetY ?? 0),
          rotation: Number(item.rotation ?? 0),
          alpha: Math.max(0, Math.min(1, Number(item.alpha ?? 1))),
          loop: item.loop !== false,
          startSec: Number(item.startSec ?? 0),
          endSec: Number(item.endSec ?? 3),
          text: String(item.text ?? "").trim() || undefined,
          matchTags: String(item.matchTagsText ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          matchHighlightTypes: String(item.matchHighlightTypesText ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        })),
    },
  };
}

async function loadStickerTemplates() {
  try {
    const manifest = await api.listStickerTemplates();
    stickerTemplates.value = manifest.templates ?? [];
  } catch (err) {
    console.warn("加载贴花模板清单失败:", err);
    stickerTemplates.value = [];
  }
}


function makeEmptyCornerWatermark(): Record<string, unknown> {
  return {
    enabled: true,
    mode: "one_random",
    randomRatio: 0.5,
    randomSeed: 0,
    text: "热门短剧",
    fontName: "Microsoft YaHei",
    fontSize: 48,
    color: "#FFFFFF",
    outlineColor: "#000000",
    outlineWidth: 2,
    backgroundColor: "#FF0000",
    backgroundAlpha: 1,
    position: "top-right",
    margin: 24,
    rotation: undefined as number | undefined,
    style: "ribbon",
  };
}

function addCornerWatermark() {
  cornerWatermarks.push(makeEmptyCornerWatermark());
}

function removeCornerWatermark(index: number) {
  cornerWatermarks.splice(index, 1);
}

function makeEmptyDisclaimerLine(): Record<string, unknown> {
  return {
    enabled: true,
    text: "",
    position: "bottom",
    style: "standard",
    fontName: "Microsoft YaHei",
    fontSize: 28,
    color: "#FFFFFF",
    outlineColor: "#000000",
    outlineWidth: 2,
    margin: 24,
    charSpacing: 4,
    backgroundColor: "#000000",
    backgroundAlpha: 0.35,
  };
}

function addDisclaimerLine() {
  disclaimer.lines.push(makeEmptyDisclaimerLine());
}

function normalizeDisclaimerLinesInput(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (typeof raw === "string") return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return [];
}

const titleCardPresets = [
  {
    id: "gold",
    label: "金色大字",
    patch: {
      fontName: "Microsoft YaHei",
      fontSize: 72,
      color: "#FFD700",
      outlineColor: "#000000",
      outlineWidth: 4,
      position: "top",
      marginV: 56,
    },
  },
  {
    id: "white",
    label: "白色清爽",
    patch: {
      fontName: "Microsoft YaHei",
      fontSize: 56,
      color: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 3,
      position: "top",
      marginV: 60,
    },
  },
  {
    id: "red",
    label: "血红冲击",
    patch: {
      fontName: "Microsoft YaHei",
      fontSize: 68,
      color: "#FF3333",
      outlineColor: "#1A0000",
      outlineWidth: 4,
      position: "center",
      marginV: 40,
    },
  },
  {
    id: "cyan",
    label: "青蓝科技",
    patch: {
      fontName: "Microsoft YaHei",
      fontSize: 60,
      color: "#00E5FF",
      outlineColor: "#003344",
      outlineWidth: 3,
      position: "top",
      marginV: 52,
    },
  },
] as const;
function applyPipelineFromRender(render: Record<string, unknown> | undefined) {
  const limits = (render?.limits ?? {}) as Record<string, unknown>;
  const tos = ((render?.storage as Record<string, unknown> | undefined)?.tos ?? {}) as Record<
    string,
    unknown
  >;
  pipeline.llmRenderPipeline = limits.llmRenderPipeline !== false;
  pipeline.maxConcurrentRenders = Number(limits.maxConcurrentRenders ?? 2);
  pipeline.maxConcurrentUploads = Number(limits.maxConcurrentUploads ?? limits.maxConcurrentRenders ?? 2);
  pipeline.maxDurationSec = Number(limits.maxDurationSec ?? 1200);
  pipeline.uploadAfterRender = limits.uploadAfterRender === true;
  pipeline.localOutputDir = String(limits.localOutputDir ?? "D:/ClipOutput");
  pipeline.tosEnabled = tos.enabled === true;
  pipeline.tosEndpoint = String(tos.endpoint ?? "");
  pipeline.tosBucket = String(tos.bucket ?? "");
  pipeline.tosRegion = String(tos.region ?? "cn-beijing");
  pipeline.tosAccessKey = String(tos.accessKey ?? "");
  pipeline.tosAccessSecret = "";
  pipeline.tosAccessSecretMasked = tos.accessSecretMasked
    ? String(tos.accessSecretMasked)
    : tos.accessSecret
      ? "已配置 ****"
      : "";
  pipeline.tosAccessSecretEncoding =
    tos.accessSecretEncoding === "plain" ? "plain" : "base64";
  pipeline.tosKeyPrefix = String(tos.keyPrefix ?? "");
  pipeline.tosPublicBaseUrl = String(tos.publicBaseUrl ?? "");
  const transition = (render?.transition ?? {}) as Record<string, unknown>;
  pipeline.transitionEnabled = transition.enabled === true;
  pipeline.transitionType = String(transition.type ?? "random");
  pipeline.transitionDurationSec = Number(transition.durationSec ?? 0.5);
  const sub = (render?.subtitleStyle ?? {}) as Record<string, unknown>;
  subtitleStyle.enabled = sub.enabled !== false;
  subtitleStyle.fontName = String(sub.fontName ?? "Microsoft YaHei");
  subtitleStyle.fontSize = Number(sub.fontSize ?? 48);
  subtitleStyle.primaryColor = String(sub.primaryColor ?? "&H00FFFFFF");
  subtitleStyle.outlineColor = String(sub.outlineColor ?? "&H00000000");
  subtitleStyle.outlineWidth = Number(sub.outlineWidth ?? 2);
  subtitleStyle.marginV = Number(sub.marginV ?? 80);
  subtitleStyle.alignment = (sub.alignment === "center" || sub.alignment === "top" ? sub.alignment : "bottom");
  subtitleStyle.style = (sub.style === "glow" || sub.style === "stroke3d" || sub.style === "softshadow" ? sub.style : "standard") as typeof subtitleStyle.style;
  const bgmCfg = (render?.bgm ?? {}) as Record<string, unknown>;
  bgm.enabled = bgmCfg.enabled === true;
  bgm.volume = Number(bgmCfg.volume ?? 0.25);
  bgm.fadeInSec = Number(bgmCfg.fadeInSec ?? 1);
  bgm.fadeOutSec = Number(bgmCfg.fadeOutSec ?? 2);
  bgm.loop = bgmCfg.loop !== false;
  const trackRows: Array<{ name: string; url: string }> = [];
  if (Array.isArray(bgmCfg.tracks)) {
    for (const t of bgmCfg.tracks) {
      const row = (t ?? {}) as Record<string, unknown>;
      const url = String(row.url ?? "").trim();
      if (!url) continue;
      trackRows.push({ name: String(row.name ?? ""), url });
    }
  }
  // 兼容旧单曲 url
  if (!trackRows.length && String(bgmCfg.url ?? "").trim()) {
    trackRows.push({ name: "", url: String(bgmCfg.url).trim() });
  }
  bgm.tracks.splice(0, bgm.tracks.length, ...trackRows);
  const cards = (render?.titleCards ?? []) as Array<Record<string, unknown>>;
  titleCards.splice(0, titleCards.length, ...cards.map((c) => ({
    text: String(c.text ?? ""),
    fontName: String(c.fontName ?? "Microsoft YaHei"),
    fontSize: Number(c.fontSize ?? 64),
    color: normalizeHexColor(String(c.color ?? "#FFD700"), "#FFD700"),
    outlineColor: normalizeHexColor(String(c.outlineColor ?? "#000000"), "#000000"),
    outlineWidth: Number(c.outlineWidth ?? 3),
    backgroundColor: normalizeHexColor(String(c.backgroundColor ?? "#000000"), "#000000"),
    backgroundAlpha: Math.max(0, Math.min(1, Number(c.backgroundAlpha ?? 0.35))),
    position: c.position === "center" || c.position === "bottom" ? c.position : "top",
    marginV: Number(c.marginV ?? 60),
    style: (["standard", "bar", "glow", "stroke3d", "vertical"].includes(String(c.style)) ? c.style : "standard") as import("@clip/sdk").TitleCardStyle,
    mode: (c.mode === "all" ? "all" : "one_random") as import("@clip/sdk").TitleCardMode,
    charSpacing: Number(c.charSpacing ?? 4),
  })));
  const d = (render?.disclaimer ?? {}) as Record<string, unknown>;
  disclaimer.enabled = d.enabled === true;
  const rawDefaultLines = d.defaultLines ?? d.text;
  disclaimer.defaultLines = Array.isArray(rawDefaultLines)
    ? rawDefaultLines.filter((s): s is string => typeof s === "string").join("\n")
    : typeof rawDefaultLines === "string"
      ? String(rawDefaultLines)
      : "热门短剧 影视效果 请勿模仿\n本故事纯属虚构 请树立正确价值观\n热门短剧 剧情虚构 无不良引导\n热门短剧 本故事纯属虚构\n剧情纯属虚构 请勿模仿\n剧情演绎纯属虚构 爆款短剧 正在热播";
  disclaimer.mode = (d.mode === "all" || d.mode === "round_robin" ? d.mode : "one_random") as "one_random" | "round_robin" | "all";
  const incomingLines = Array.isArray(d.lines) ? d.lines : [];
  disclaimer.lines.splice(
    0,
    disclaimer.lines.length,
    ...incomingLines.map((l) => ({
      enabled: (l as Record<string, unknown>).enabled !== false,
      text: String((l as Record<string, unknown>).text ?? ""),
      position: ((l as Record<string, unknown>).position === "top" || (l as Record<string, unknown>).position === "left" || (l as Record<string, unknown>).position === "right"
        ? (l as Record<string, unknown>).position
        : "bottom") as "top" | "bottom" | "left" | "right",
    style: ((["standard", "bar", "glow", "vertical"].includes(String((l as Record<string, unknown>).style))
      ? (l as Record<string, unknown>).style
      : "standard") as "standard" | "bar" | "glow" | "vertical"),
      fontName: String((l as Record<string, unknown>).fontName ?? "Microsoft YaHei"),
      fontSize: Number((l as Record<string, unknown>).fontSize ?? 28),
      color: normalizeHexColor(String((l as Record<string, unknown>).color ?? "#FFFFFF"), "#FFFFFF"),
      outlineColor: normalizeHexColor(String((l as Record<string, unknown>).outlineColor ?? "#000000"), "#000000"),
      outlineWidth: Number((l as Record<string, unknown>).outlineWidth ?? 2),
      margin: Number((l as Record<string, unknown>).margin ?? 24),
      charSpacing: Number((l as Record<string, unknown>).charSpacing ?? 4),
      backgroundColor: normalizeHexColor(String((l as Record<string, unknown>).backgroundColor ?? "#000000"), "#000000"),
      backgroundAlpha: Math.max(0, Math.min(1, Number((l as Record<string, unknown>).backgroundAlpha ?? 0.35))),
    })),
  );

  // 优先加载多角标数组；没有时回退旧版单条
  const wmList = (render?.cornerWatermarks ?? []) as Array<Record<string, unknown>>;
  if (Array.isArray(wmList) && wmList.length > 0) {
    cornerWatermarks.splice(
      0,
      cornerWatermarks.length,
      ...wmList.map((w) => ({
        enabled: (w as Record<string, unknown>).enabled !== false,
        mode: ((w as Record<string, unknown>).mode === "random" || (w as Record<string, unknown>).mode === "none"
          ? (w as Record<string, unknown>).mode
          : "all") as "all" | "random" | "none",
        randomRatio: Math.max(0, Math.min(1, Number((w as Record<string, unknown>).randomRatio ?? 0.5))),
        randomSeed: Number((w as Record<string, unknown>).randomSeed ?? 0),
        text: String((w as Record<string, unknown>).text ?? "").trim() || "热门短剧",
        fontName: String((w as Record<string, unknown>).fontName ?? "Microsoft YaHei"),
        fontSize: Number((w as Record<string, unknown>).fontSize ?? 48),
        color: normalizeHexColor(String((w as Record<string, unknown>).color ?? "#FFFFFF"), "#FFFFFF"),
        outlineColor: normalizeHexColor(String((w as Record<string, unknown>).outlineColor ?? "#000000"), "#000000"),
        outlineWidth: Number((w as Record<string, unknown>).outlineWidth ?? 2),
        backgroundColor: normalizeHexColor(String((w as Record<string, unknown>).backgroundColor ?? "#FF0000"), "#FF0000"),
        backgroundAlpha: Math.max(0, Math.min(1, Number((w as Record<string, unknown>).backgroundAlpha ?? 1))),
        position: (
          (w as Record<string, unknown>).position === "top-left" ||
          (w as Record<string, unknown>).position === "top-right" ||
          (w as Record<string, unknown>).position === "center-left" ||
          (w as Record<string, unknown>).position === "center-right" ||
          (w as Record<string, unknown>).position === "bottom-left" ||
          (w as Record<string, unknown>).position === "bottom-right"
            ? (w as Record<string, unknown>).position
            : "top-right"
        ) as import("@clip/sdk").CornerWatermarkPosition,
        margin: Number((w as Record<string, unknown>).margin ?? 24),
        rotation: (w as Record<string, unknown>).rotation !== undefined && !Number.isNaN(Number((w as Record<string, unknown>).rotation))
          ? Number((w as Record<string, unknown>).rotation)
          : undefined as number | undefined,
        style: (
          ["standard", "tape", "badge", "flag", "pulsing", "glow", "stroke3d", "none"].includes(String((w as Record<string, unknown>).style))
            ? (w as Record<string, unknown>).style
            : "ribbon"
        ) as import("@clip/sdk").CornerWatermarkStyle,
      })),
    );
  } else {
    const wm = (render?.cornerWatermark ?? {}) as Record<string, unknown>;
    cornerWatermark.enabled = wm.enabled === true;
    const rawMode = String(wm.mode ?? "all");
    cornerWatermark.mode = rawMode === "random" || rawMode === "none" ? (rawMode as "random" | "none") : "all";
    cornerWatermark.randomRatio = Math.max(0, Math.min(1, Number(wm.randomRatio ?? 0.5)));
    cornerWatermark.randomSeed = Number(wm.randomSeed ?? 0);
    cornerWatermark.text = String(wm.text ?? "").trim() || "热门短剧";
    cornerWatermark.fontName = String(wm.fontName ?? "Microsoft YaHei");
    cornerWatermark.fontSize = Number(wm.fontSize ?? 48);
    cornerWatermark.color = normalizeHexColor(String(wm.color ?? "#FFFFFF"), "#FFFFFF");
    cornerWatermark.outlineColor = normalizeHexColor(String(wm.outlineColor ?? "#000000"), "#000000");
    cornerWatermark.outlineWidth = Number(wm.outlineWidth ?? 2);
    cornerWatermark.backgroundColor = normalizeHexColor(String(wm.backgroundColor ?? "#FF0000"), "#FF0000");
    cornerWatermark.backgroundAlpha = Math.max(0, Math.min(1, Number(wm.backgroundAlpha ?? 1)));
    cornerWatermark.margin = Number(wm.margin ?? 24);
    cornerWatermark.rotation = Number(wm.rotation ?? 30);
    cornerWatermark.style = (["standard", "tape", "badge", "flag", "pulsing", "glow", "stroke3d", "none"].includes(String(wm.style))
      ? wm.style
      : "ribbon") as "ribbon" | "tape" | "badge" | "flag" | "pulsing" | "standard" | "glow" | "stroke3d" | "none";
    cornerWatermarks.splice(0, cornerWatermarks.length);
  }
  applyWordArtFromRender(render);
  applyStickersFromRender(render);
}

function buildTosStoragePatch(existingTos?: Record<string, unknown>): Record<string, unknown> {
  const tos: Record<string, unknown> = {
    enabled: pipeline.tosEnabled === true,
    endpoint: pipeline.tosEndpoint.trim() || undefined,
    bucket: pipeline.tosBucket.trim() || undefined,
    region: pipeline.tosRegion.trim() || "cn-beijing",
    accessKey: pipeline.tosAccessKey.trim() || undefined,
    accessSecretEncoding: pipeline.tosAccessSecretEncoding,
    keyPrefix: pipeline.tosKeyPrefix.trim() || undefined,
    publicBaseUrl: pipeline.tosPublicBaseUrl.trim() || undefined,
  };
  const incomingSecret = pipeline.tosAccessSecret.trim();
  if (incomingSecret) tos.accessSecret = incomingSecret;
  else if (existingTos?.accessSecret) tos.accessSecret = existingTos.accessSecret;
  return tos;
}

function mergeStorageIntoRender(render: Record<string, unknown>): Record<string, unknown> {
  const existingStorage = (render.storage ?? {}) as Record<string, unknown>;
  const existingTos = (existingStorage.tos ?? {}) as Record<string, unknown>;
  const storage = {
    ...existingStorage,
    tos: buildTosStoragePatch(existingTos),
  };
  return { ...render, storage };
}

onMounted(async () => {
  global.value = await api.getGlobalConfig();
  renderJson.value = JSON.stringify(global.value.render ?? {}, null, 2);
  applyPipelineFromRender(global.value.render as Record<string, unknown> | undefined);
  const services = (global.value.services ?? {}) as Record<string, unknown>;
  resourcePolicy.value = (services.resourcePolicy as Partial<ResourcePolicyForm> | undefined) ?? null;
  await loadStickerTemplates();
  await loadFonts();
});

function mergePipelineIntoRender(): Record<string, unknown> {
  const render = JSON.parse(renderJson.value) as Record<string, unknown>;
  const limits = {
    ...((render.limits ?? {}) as Record<string, unknown>),
    llmRenderPipeline: pipeline.llmRenderPipeline,
    maxConcurrentRenders: Math.max(1, Math.min(8, Number(pipeline.maxConcurrentRenders) || 2)),
    maxConcurrentUploads: Math.max(1, Math.min(8, Number(pipeline.maxConcurrentUploads) || 2)),
    maxDurationSec: Math.min(1200, Math.max(120, Number(pipeline.maxDurationSec) || 1200)),
   uploadAfterRender: pipeline.uploadAfterRender === true,
   localOutputDir: pipeline.localOutputDir?.trim() || undefined,
 };
  const transition = {
    ...((render.transition ?? {}) as Record<string, unknown>),
    enabled: pipeline.transitionEnabled === true,
    type: pipeline.transitionType || "random",
    durationSec: Number(pipeline.transitionDurationSec ?? 0.5),
  };
  const subtitleStylePatch = {
    ...((render.subtitleStyle ?? {}) as Record<string, unknown>),
    enabled: subtitleStyle.enabled === true,
    fontName: subtitleStyle.fontName || undefined,
    fontSize: Number(subtitleStyle.fontSize ?? 48),
    primaryColor: subtitleStyle.primaryColor || undefined,
    outlineColor: subtitleStyle.outlineColor || undefined,
    outlineWidth: Number(subtitleStyle.outlineWidth ?? 2),
    marginV: Number(subtitleStyle.marginV ?? 80),
    alignment: subtitleStyle.alignment ?? "bottom",
    style: subtitleStyle.style ?? "standard",
  };
  const tracks = bgm.tracks
    .map((t) => ({
      name: String(t.name ?? "").trim() || undefined,
      url: String(t.url ?? "").trim(),
    }))
    .filter((t) => Boolean(t.url));
  const bgmPatch = {
    enabled: bgm.enabled === true,
    tracks,
    // 清空旧单曲字段，避免与 tracks 并存干扰
    url: undefined,
    volume: Number(bgm.volume ?? 0.25),
    fadeInSec: Number(bgm.fadeInSec ?? 1),
    fadeOutSec: Number(bgm.fadeOutSec ?? 2),
    loop: bgm.loop !== false,
  };
    const titleCardsPatch = titleCards.map((c) => ({
    text: String(c.text ?? ""),
    fontName: String(c.fontName ?? "").trim() || undefined,
    fontSize: Number(c.fontSize ?? 64),
    color: normalizeHexColor(String(c.color ?? "#FFD700"), "#FFD700"),
    outlineColor: normalizeHexColor(String(c.outlineColor ?? "#000000"), "#000000"),
    outlineWidth: Number(c.outlineWidth ?? 3),
    backgroundColor: normalizeHexColor(String(c.backgroundColor ?? "#000000"), "#000000"),
    backgroundAlpha: Math.max(0, Math.min(1, Number(c.backgroundAlpha ?? 0.35))),
    position: c.position ?? "top",
    marginV: Number(c.marginV ?? 60),
    style: c.style ?? "standard",
    mode: c.mode ?? "one_random",
    charSpacing: Number(c.charSpacing ?? 4),
  }));
  const cornerWatermarksPatch = cornerWatermarks
    .filter((w) => w.enabled !== false)
    .map((w) => ({
      enabled: true,
      mode: (w.mode === "random" || w.mode === "none" ? w.mode : "all") as "all" | "random" | "none",
      randomRatio: Math.max(0, Math.min(1, Number(w.randomRatio ?? 0.5))),
      randomSeed: Number(w.randomSeed ?? 0),
      text: String(w.text ?? "").trim() || "热门短剧",
      fontName: String(w.fontName ?? "").trim() || undefined,
      fontSize: Number(w.fontSize ?? 48),
      color: normalizeHexColor(String(w.color ?? "#FFFFFF"), "#FFFFFF"),
      outlineColor: normalizeHexColor(String(w.outlineColor ?? "#000000"), "#000000"),
      outlineWidth: Number(w.outlineWidth ?? 2),
      backgroundColor: normalizeHexColor(String(w.backgroundColor ?? "#FF0000"), "#FF0000"),
      backgroundAlpha: Math.max(0, Math.min(1, Number(w.backgroundAlpha ?? 1))),
      position: (
        w.position === "top-left" || w.position === "top-right" ||
        w.position === "center-left" || w.position === "center-right" ||
        w.position === "bottom-left" || w.position === "bottom-right"
          ? w.position
          : "top-right"
      ) as import("@clip/sdk").CornerWatermarkPosition,
      margin: Number(w.margin ?? 24),
      rotation: w.rotation === undefined || Number.isNaN(Number(w.rotation)) ? undefined : Number(w.rotation),
      style: (
        ["standard", "tape", "badge", "flag", "pulsing", "glow", "stroke3d", "none"].includes(String(w.style))
          ? w.style
          : "ribbon"
      ) as import("@clip/sdk").CornerWatermarkStyle,
    }));
  // 兼容旧版单条配置：如果新数组为空且旧版存在，则回退生成旧版字段
  const legacyCornerWatermarkPatch = cornerWatermarksPatch.length
    ? undefined
    : {
        enabled: cornerWatermark.enabled === true,
        mode: cornerWatermark.mode ?? "all",
        randomRatio: Math.max(0, Math.min(1, Number(cornerWatermark.randomRatio ?? 0.5))),
        randomSeed: Number(cornerWatermark.randomSeed ?? 0),
        text: String(cornerWatermark.text ?? "").trim() || "热门短剧",
        fontName: String(cornerWatermark.fontName ?? "").trim() || undefined,
        fontSize: Number(cornerWatermark.fontSize ?? 48),
      color: normalizeHexColor(String(cornerWatermark.color ?? "#FFFFFF"), "#FFFFFF"),
      outlineColor: normalizeHexColor(String(cornerWatermark.outlineColor ?? "#000000"), "#000000"),
      outlineWidth: Number(cornerWatermark.outlineWidth ?? 2),
      backgroundColor: normalizeHexColor(String(cornerWatermark.backgroundColor ?? "#FF0000"), "#FF0000"),
        backgroundAlpha: Math.max(0, Math.min(1, Number(cornerWatermark.backgroundAlpha ?? 1))),
        margin: Number(cornerWatermark.margin ?? 24),
        rotation: Number(cornerWatermark.rotation ?? 30),
        style: cornerWatermark.style ?? "ribbon",
      };
  // 角标兼容：优先多角标数组；空数组时回退旧字段
  const cornerWatermarkFinalPatch = cornerWatermarksPatch.length
    ? { cornerWatermarks: cornerWatermarksPatch }
    : { cornerWatermark: legacyCornerWatermarkPatch };
  const disclaimerPatch = {
    enabled: disclaimer.enabled === true,
    defaultLines: normalizeDisclaimerLinesInput(disclaimer.defaultLines),
    mode: disclaimer.mode ?? "one_random",
    lines: disclaimer.lines
      .filter((l) => l.enabled !== false)
      .map((l) => ({
        enabled: l.enabled !== false,
        text: String(l.text ?? "").trim() || undefined,
        position: (l.position === "top" || l.position === "left" || l.position === "right" ? l.position : "bottom") as "top" | "bottom" | "left" | "right",
        style: l.style ?? "standard",
        fontName: String(l.fontName ?? "").trim() || undefined,
        fontSize: Number(l.fontSize ?? 28),
        color: normalizeHexColor(String(l.color ?? "#FFFFFF"), "#FFFFFF"),
        outlineColor: normalizeHexColor(String(l.outlineColor ?? "#000000"), "#000000"),
        outlineWidth: Number(l.outlineWidth ?? 2),
        margin: Number(l.margin ?? 24),
        charSpacing: Number(l.charSpacing ?? 4),
        backgroundColor: normalizeHexColor(String(l.backgroundColor ?? "#000000"), "#000000"),
        backgroundAlpha: Math.max(0, Math.min(1, Number(l.backgroundAlpha ?? 0.35))),
      })),
  };
  return mergeStorageIntoRender({ ...render, limits, transition, subtitleStyle: subtitleStylePatch, bgm: bgmPatch, titleCards: titleCardsPatch, ...cornerWatermarkFinalPatch, disclaimer: disclaimerPatch, ...mergeWordArtIntoRender(), ...mergeStickersIntoRender() });
}

function normalizeHexColor(raw: string, fallback: string): string {
  const s = raw.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s.toUpperCase();
  if (/^[0-9A-Fa-f]{6}$/.test(s)) return `#${s.toUpperCase()}`;
  return fallback;
}

function addBgmTrack() {
  bgm.tracks.push({ name: "", url: "" });
}

function addTitleCard() {
  titleCards.push({
    text: "",
    fontName: "Microsoft YaHei",
    fontSize: 64,
    color: "#FFD700",
    outlineColor: "#000000",
    outlineWidth: 3,
    backgroundColor: "#000000",
    backgroundAlpha: 0.35,
    position: "top",
    marginV: 60,
    style: "standard",
    mode: "one_random",
    charSpacing: 4,
  });
}

function applyTitleCardPreset(idx: number, presetId: string) {
  if (!presetId) return;
  const preset = titleCardPresets.find((p) => p.id === presetId);
  const card = titleCards[idx];
  if (!preset || !card) return;
  Object.assign(card, preset.patch);
}

async function saveResourcePolicy(payload: ResourcePolicyForm | null) {
  if (!payload) return;
  global.value = await api.updateGlobalConfig({
    services: { resourcePolicy: payload },
  });
  const services = (global.value.services ?? {}) as Record<string, unknown>;
  resourcePolicy.value = (services.resourcePolicy as Partial<ResourcePolicyForm> | undefined) ?? payload;
  alert("资源策略已保存，Agent 约 60 秒内心跳后生效");
}

async function savePipeline() {
  const render = mergePipelineIntoRender();
  await api.updateGlobalConfig({ render });
  global.value = await api.getGlobalConfig();
  renderJson.value = JSON.stringify(global.value.render ?? {}, null, 2);
  applyPipelineFromRender(global.value.render as Record<string, unknown> | undefined);
  alert("流水线配置已保存，configVersion 已更新");
}

async function saveRender() {
  const parsed = JSON.parse(renderJson.value) as Record<string, unknown>;
  const limits = {
    ...((parsed.limits ?? {}) as Record<string, unknown>),
    llmRenderPipeline: pipeline.llmRenderPipeline,
    maxConcurrentRenders: pipeline.maxConcurrentRenders,
    maxConcurrentUploads: pipeline.maxConcurrentUploads,
    maxDurationSec: pipeline.maxDurationSec,
    uploadAfterRender: pipeline.uploadAfterRender === true,
    localOutputDir: pipeline.localOutputDir?.trim() || undefined,
  };
  parsed.limits = limits;
  const transition = {
    ...((parsed.transition ?? {}) as Record<string, unknown>),
    enabled: pipeline.transitionEnabled === true,
    type: pipeline.transitionType || "random",
    durationSec: Number(pipeline.transitionDurationSec ?? 0.5),
  };
  parsed.transition = transition;
  await api.updateGlobalConfig({ render: mergeStorageIntoRender(parsed) });
  global.value = await api.getGlobalConfig();
  renderJson.value = JSON.stringify(global.value.render ?? {}, null, 2);
  applyPipelineFromRender(global.value.render as Record<string, unknown> | undefined);
  alert("渲染配置已保存，configVersion 已更新");
}

</script>

<style scoped>
.config-page {
  max-width: 1100px;
}
.config-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.config-hero h2 {
  margin: 0 0 6px;
}
.config-hero-desc {
  margin: 0;
  font-size: 13px;
  color: #64748b;
  line-height: 1.5;
  max-width: 640px;
}
.config-version {
  flex-shrink: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  font-size: 12px;
  color: #64748b;
  text-align: right;
}
.config-version strong {
  display: block;
  margin-top: 2px;
  color: #0f172a;
  font-size: 14px;
}
.config-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 18px;
  padding: 4px;
  border-radius: 12px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
}
.config-tab {
  flex: 1 1 140px;
  min-width: 120px;
  max-width: 180px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: #475569;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.config-tab:hover {
  background: #fff;
  color: #0f172a;
}
.config-tab.active {
  background: #fff;
  border-color: #93c5fd;
  color: #1d4ed8;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}
.config-tab b {
  font-size: 13px;
  font-weight: 650;
}
.config-tab small {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.3;
}
.config-tab.active small {
  color: #64748b;
}
.config-panel {
  display: block;
}
.config-panel-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.config-section {
  margin: 0 0 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e2e8f0;
}
.config-section:last-of-type {
  border-bottom: none;
  margin-bottom: 8px;
  padding-bottom: 0;
}
.config-section-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 650;
  color: #0f172a;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px 16px;
  margin-bottom: 8px;
}
.field-grid .field {
  margin-bottom: 0;
}
.field-grid .field input,
.field-grid .field select {
  max-width: none;
}
.hint {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 8px;
}
.field {
  margin-bottom: 16px;
}
.field-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.field-desc {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 6px;
  line-height: 1.45;
}
.field input[type="number"],
.field input[type="text"],
.field input[type="password"],
.field input[type="url"],
.field select,
.field textarea {
  width: 100%;
  max-width: 420px;
  box-sizing: border-box;
}
.tos-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px 16px;
  margin-bottom: 8px;
  padding: 12px;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
}
.subsection-title {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.full-width {
  grid-column: 1 / -1;
}
.prompt-area {
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  box-sizing: border-box;
}
.btn.secondary {
  background: #e2e8f0;
  color: #0f172a;
}
.field-warn {
  margin: 8px 0 0;
  font-size: 12px;
  color: #b45309;
  line-height: 1.45;
}
.field-warn-banner {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fef3c7;
  border: 1px solid #fcd34d;
}
.ok-text {
  color: #15803d;
}
.warn-text {
  color: #b45309;
}
.bgm-track-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
}
.bgm-track-list.disabled {
  opacity: 0.55;
}
.bgm-track-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.bgm-name-input {
  width: 140px;
  max-width: 30%;
}
.bgm-url-input {
  flex: 1;
  min-width: 220px;
}
.title-card-block {
  margin: 0 0 14px;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}
.title-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.card-preset-select {
  min-width: 160px;
}
.title-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 12px;
}
.word-art-items.disabled,
.title-card-grid.disabled {
  opacity: 0.55;
  pointer-events: none;
}
.title-card-grid .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}
.title-card-grid .field-label {
  font-size: 12px;
  color: #64748b;
}
.card-color-swatch {
  width: 42px;
  height: 32px;
  padding: 0;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: transparent;
}
.card-color-hex {
  margin-top: 4px;
}
.disclaimer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 12px;
  margin: 12px 0;
}
.disclaimer-grid.disabled,
.disclaimer-lines.disabled {
  opacity: 0.55;
}
.disclaimer-grid .field,
.disclaimer-lines .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}
.disclaimer-grid .field:first-child,
.disclaimer-defaults .field:first-child {
  grid-column: 1 / -1;
}
.disclaimer-defaults {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px 12px;
  margin: 0 0 12px;
}
.disclaimer-defaults textarea,
.disclaimer-lines textarea {
  width: 100%;
  min-height: 64px;
  font-family: inherit;
  font-size: 13px;
  padding: 8px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  resize: vertical;
}
.disclaimer-lines .field-label {
  font-size: 12px;
  color: #64748b;
}
.disclaimer-line-block {
  margin: 0 0 14px;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}
.disclaimer-line-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.disclaimer-line-head .line-enabled {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #334155;
}
.disclaimer-line-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 12px;
}
.disclaimer-grid .field-label {
  font-size: 12px;
  color: #64748b;
}
.check-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.check-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  font-size: 13px;
}
.check-list .ok {
  color: #15803d;
}
.check-list .warning {
  color: #b45309;
  font-weight: 600;
}
@media (max-width: 720px) {
  .config-hero {
    flex-direction: column;
  }
  .config-tab {
    max-width: none;
  }
}
.hub-embed :deep(> h2:first-child) {
  display: none;
}
</style>
