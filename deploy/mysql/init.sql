-- =============================================================================
-- drama-clip MySQL 一键初始化（唯一 SQL 文件，含 schema + 种子数据）
--
-- 用法（删表重建，保留库名 clip_platform）:
--   mysql -u root -p clip_platform < deploy/mysql/init.sql
--
-- 用法（删库重建）:
--   mysql -u root -p -e "DROP DATABASE IF EXISTS clip_platform; CREATE DATABASE clip_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
--   mysql -u root -p clip_platform < deploy/mysql/init.sql
--
-- 表清单:
--   clip_device                      剪辑 Agent 设备（员工 GPU 电脑）
--   clip_device_config               单设备配置覆盖（渲染/ASR 规则/服务开关）
--   clip_config_profile              全局剪辑 Profile（ASR 模型、渲染参数、服务开关）
--   clip_bgm_settings / clip_bgm_track 全局 BGM 混音参数与候选曲目（仅 URL，不存文件）
--   clip_agent_update_manifest       Agent 客户端升级清单
--   clip_asr_rule_set                ASR 识别规则集（VAD/合并/过滤/热词等）
--   clip_drama                       短剧/剧目（含复刻特征缓存字段）
--   clip_drama_intake                短剧待入库清单（剧名+来源 ID+进度状态）
--   clip_drama_episode               剧目分集
--   clip_task                        剪辑任务（单集/识别/混剪/整包/复刻）
--   clip_remix_job                   案例复刻任务扩展表（案例视频/裂变配置）
--   clip_task_mix_episode            混剪任务与分集的关联
--   clip_drama_package_name_index    整包 zip 命名 dedup 序号
--   clip_package_cache / clip_package_cache_event 剧包本地缓存元数据与事件
--   clip_edit_marker                 人工高光/剪辑标记
--   clip_asr_result                  ASR 识别结果摘要（按任务维度）
--   clip_asr_segment                 ASR 处理后句级片段（规则引擎输出）
--   clip_asr_raw_segment             ASR 原始片段（FunASR 直出，规则引擎输入）
--   clip_mix_render                  混剪任务多轮成片记录
--   clip_task_output                 单任务成片输出
--   clip_telemetry_batch             遥测上报批次
--   clip_telemetry_event             遥测事件明细
--   clip_device_daily_stats          设备日报聚合统计
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS clip_telemetry_event;
DROP TABLE IF EXISTS clip_telemetry_batch;
DROP TABLE IF EXISTS clip_device_daily_stats;
DROP TABLE IF EXISTS clip_asr_segment;
DROP TABLE IF EXISTS clip_asr_raw_segment;
DROP TABLE IF EXISTS clip_task_mix_episode;
DROP TABLE IF EXISTS clip_package_cache_event;
DROP TABLE IF EXISTS clip_package_cache;
DROP TABLE IF EXISTS clip_edit_marker;
DROP TABLE IF EXISTS clip_task_output;
DROP TABLE IF EXISTS clip_mix_render;
DROP TABLE IF EXISTS clip_asr_result;
DROP TABLE IF EXISTS clip_remix_job;
DROP TABLE IF EXISTS clip_task;
DROP TABLE IF EXISTS clip_drama_episode;
DROP TABLE IF EXISTS clip_drama_package_name_index;
DROP TABLE IF EXISTS clip_drama_intake;
DROP TABLE IF EXISTS clip_drama;
DROP TABLE IF EXISTS clip_device_config;
DROP TABLE IF EXISTS clip_device;
DROP TABLE IF EXISTS clip_config_profile;
DROP TABLE IF EXISTS clip_bgm_track;
DROP TABLE IF EXISTS clip_bgm_settings;
DROP TABLE IF EXISTS clip_agent_update_manifest;
DROP TABLE IF EXISTS clip_asr_rule_set;

SET FOREIGN_KEY_CHECKS = 1;

-- -----------------------------------------------------------------------------
-- clip_device: 剪辑 Agent 设备
-- 说明: 注册并管理员工侧 GPU 剪辑机，Agent 启动时自动注册，心跳维持在线状态
-- -----------------------------------------------------------------------------
CREATE TABLE clip_device (
  device_id       CHAR(36)     NOT NULL COMMENT '设备唯一 ID（UUID），主键',
  device_token    CHAR(36)     NOT NULL COMMENT 'Agent API 鉴权 Token，请求头 x-device-token',
  machine_id      VARCHAR(128) NOT NULL COMMENT '机器标识（如 COMPUTERNAME/HOSTNAME），同机重复注册时复用',
  gpu_name        VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'GPU 型号，如 NVIDIA GeForce RTX 4060',
  vram_mb         INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '显存容量（MB）',
  os              VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '操作系统，如 Windows 11',
  agent_version   VARCHAR(32)  NOT NULL DEFAULT '' COMMENT 'Agent 客户端版本号',
  bound_user      VARCHAR(128) NULL     COMMENT '绑定运营用户 ID（预留，用于权限/归属）',
  last_seen_at    DATETIME(3)  NOT NULL COMMENT '最后一次心跳时间，用于判断在线',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '首次注册时间',
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '记录最后更新时间',
  PRIMARY KEY (device_id),
  UNIQUE KEY uk_clip_device_machine (machine_id),
  UNIQUE KEY uk_clip_device_token (device_token),
  KEY idx_clip_device_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='剪辑 Agent 设备表';

-- -----------------------------------------------------------------------------
-- clip_device_config: 单设备配置覆盖
-- 说明: 覆盖全局 Profile 的部分字段，仅影响指定 device_id
-- -----------------------------------------------------------------------------
CREATE TABLE clip_device_config (
  device_id       CHAR(36)     NOT NULL COMMENT '设备 ID，关联 clip_device.device_id',
  asr_rule_set_id VARCHAR(64)  NULL     COMMENT '设备级 ASR 规则集 ID override，为空则跟随剧目/全局',
  render_json     JSON         NULL     COMMENT 'RenderConfig JSON 片段（编码、并发、转场等）',
  services_json   JSON         NULL     COMMENT 'AgentServicesConfig JSON（agentEnabled/taskProcessing/asrSidecar）',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='单设备配置覆盖表';

-- -----------------------------------------------------------------------------
-- clip_config_profile: 全局剪辑 Profile
-- 说明: 管理台「系统配置」保存的全局 ASR/渲染/服务开关，含 config_version 供 Agent 拉取
-- -----------------------------------------------------------------------------
CREATE TABLE clip_config_profile (
  profile_key     VARCHAR(64)  NOT NULL DEFAULT 'gpu_4060_standard' COMMENT 'Profile 名称，如 gpu_4060_standard',
  config_version  VARCHAR(64)  NOT NULL COMMENT '配置版本号 cfg-YYYYMMDD-xxx，变更后 Agent 自动刷新',
  profile_json    JSON         NOT NULL COMMENT '完整 Profile：asr.models/runtime、render、services 等',
  is_active       TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否当前生效的全局 Profile（1=是）',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (profile_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='全局剪辑 Profile 配置表';

-- -----------------------------------------------------------------------------
-- clip_bgm_settings / clip_bgm_track: 全局 BGM（仅存 URL 元数据，不存音频文件）
-- -----------------------------------------------------------------------------
CREATE TABLE clip_bgm_settings (
  settings_id   TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '单例主键，固定为 1',
  enabled       TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否启用 BGM：1=启用，0=关闭',
  volume        DECIMAL(4,3) NOT NULL DEFAULT 0.250 COMMENT 'BGM 音量 0~1',
  fade_in_sec   DECIMAL(6,2) NOT NULL DEFAULT 1.00 COMMENT '淡入秒数',
  fade_out_sec  DECIMAL(6,2) NOT NULL DEFAULT 2.00 COMMENT '淡出秒数',
  loop_enabled  TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否循环到成片结束：1=是',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (settings_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='全局 BGM 混音参数（单例）';

CREATE TABLE clip_bgm_track (
  track_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'BGM 曲目主键',
  name         VARCHAR(128) NOT NULL DEFAULT '' COMMENT '展示名称',
  url          VARCHAR(1024) NOT NULL COMMENT '音频下载 URL，不存文件本体',
  enabled      TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否参与随机候选：1=是',
  sort_order   INT NOT NULL DEFAULT 0 COMMENT '列表排序，越小越靠前',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (track_id),
  KEY idx_bgm_track_enabled_sort (enabled, sort_order, track_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='全局 BGM 候选曲目（仅 URL 元数据）';

-- -----------------------------------------------------------------------------
-- clip_agent_update_manifest: Agent 升级清单
-- 说明: Agent 心跳/启动时检查是否有新版本 MSI
-- -----------------------------------------------------------------------------
CREATE TABLE clip_agent_update_manifest (
  platform            VARCHAR(64)   NOT NULL COMMENT '目标平台，如 win-x64-4060',
  version             VARCHAR(32)   NOT NULL COMMENT '最新 Agent 版本号',
  download_url        VARCHAR(1024) NOT NULL COMMENT '安装包下载地址',
  sha256              CHAR(64)      NOT NULL COMMENT '安装包 SHA256 校验',
  mandatory           TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '是否强制升级（1=必须）',
  release_notes       TEXT          NULL     COMMENT '版本更新说明',
  incremental_url     TEXT          NULL     COMMENT '增量包下载 URL',
  incremental_sha256  CHAR(64)      NULL     COMMENT '增量包 SHA256 校验',
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Agent 客户端升级清单表';

-- -----------------------------------------------------------------------------
-- clip_asr_rule_set: ASR 识别规则集
-- 说明: 远程下发给 Agent 的识别后处理规则（VAD/句合并/过滤/热词/ITN）
-- -----------------------------------------------------------------------------
CREATE TABLE clip_asr_rule_set (
  rule_set_id       VARCHAR(64) NOT NULL COMMENT '规则集 ID，如 drama-default-v1',
  rule_set_version  VARCHAR(32) NOT NULL COMMENT '规则集版本号，变更后 Agent 重新拉取',
  rules_json        JSON        NOT NULL COMMENT '完整 AsrRules JSON（pipeline/vad/merge/filter/hotwords/text/output）',
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (rule_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ASR 识别规则集表';

-- -----------------------------------------------------------------------------
-- clip_drama: 短剧/剧目
-- 说明: 一部短剧对应一个 drama_id，可绑定默认 ASR 规则集
-- -----------------------------------------------------------------------------
CREATE TABLE clip_drama (
  drama_id          VARCHAR(64)  NOT NULL COMMENT '剧目 ID，如 drama-demo',
  title             VARCHAR(256) NOT NULL COMMENT '剧目名称',
  asr_rule_set_id   VARCHAR(64)  NOT NULL COMMENT '默认 ASR 规则集 ID，关联 clip_asr_rule_set',
  meta_json         JSON         NULL     COMMENT '扩展元数据（投放标签、简介等）',
  remix_feature_object_key    VARCHAR(512) NULL COMMENT '复刻原片特征缓存 TOS 对象键',
  remix_feature_fingerprint   VARCHAR(64)  NULL COMMENT '复刻原片集合指纹',
  remix_feature_size_bytes    BIGINT       NULL COMMENT '复刻特征缓存文件大小（字节）',
  remix_feature_frame_count   INT          NULL COMMENT '复刻特征缓存帧数',
  remix_feature_source_count  INT          NULL COMMENT '复刻特征缓存原片数',
  remix_feature_updated_at    DATETIME(3)  NULL COMMENT '复刻特征缓存更新时间',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (drama_id),
  KEY idx_clip_drama_rule_set (asr_rule_set_id),
  KEY idx_clip_drama_remix_feature (remix_feature_fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='短剧/剧目表';

-- -----------------------------------------------------------------------------
-- clip_drama_intake: 短剧待入库清单
-- 说明: 运营批量录入剧名与来源平台短剧 ID，跟踪读取/下载/上传/入库进度
-- -----------------------------------------------------------------------------
CREATE TABLE clip_drama_intake (
  intake_id           CHAR(36)     NOT NULL COMMENT '清单条目 UUID',
  external_drama_id   VARCHAR(128) NOT NULL COMMENT '来源平台短剧 ID',
  title               VARCHAR(256) NOT NULL COMMENT '剧名',
  drama_type          ENUM('comic','short','paid_comic','paid_short')
                      NOT NULL DEFAULT 'short'
                      COMMENT 'comic=漫剧; short=短剧; paid_comic=付费漫剧; paid_short=付费短剧',
  status              ENUM(
                        'pending','read','downloaded','uploaded','queued',
                        'ingesting','ingested','failed','skipped'
                      ) NOT NULL DEFAULT 'pending'
                      COMMENT 'pending=待处理; read=已读取; downloaded=已下载; uploaded=已上传; queued=已建任务; ingesting=入库中; ingested=已入库; failed=失败; skipped=已跳过',
  synopsis            TEXT         NULL     COMMENT '短剧简介（回填表示已进入已下载流程）',
  note                VARCHAR(512) NULL     COMMENT '运营备注',
  linked_task_id      VARCHAR(64)  NULL     COMMENT '关联 drama_package 任务 ID',
  linked_drama_id     VARCHAR(64)  NULL     COMMENT '入库完成后的内部 drama_id',
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (intake_id),
  UNIQUE KEY uk_clip_drama_intake_external (external_drama_id),
  KEY idx_clip_drama_intake_status (status, updated_at),
  KEY idx_clip_drama_intake_type (drama_type, updated_at),
  KEY idx_clip_drama_intake_title (title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='短剧待入库清单表';

-- -----------------------------------------------------------------------------
-- clip_drama_episode: 剧目分集
-- 说明: 多集上传后每集一条记录，ASR 完成后 status=asr_done
-- -----------------------------------------------------------------------------
CREATE TABLE clip_drama_episode (
  episode_id          VARCHAR(64)   NOT NULL COMMENT '分集 ID，如 e01',
  drama_id            VARCHAR(64)   NOT NULL COMMENT '所属剧目 ID',
  episode_no          INT UNSIGNED  NOT NULL COMMENT '集序号，从 1 开始',
  title               VARCHAR(256)  NULL     COMMENT '分集标题（可选）',
  source_url          VARCHAR(1024) NOT NULL COMMENT '源视频 URL（OSS 或 clip-local://）',
  status              ENUM('pending_asr','asr_done','failed') NOT NULL DEFAULT 'pending_asr'
                      COMMENT 'pending_asr=待识别; asr_done=识别完成; failed=识别失败',
  task_id             VARCHAR(64)   NULL     COMMENT '关联的 episode_asr 任务 ID',
  raw_segment_count   INT UNSIGNED  NULL     COMMENT 'FunASR 原始段数量（规则引擎输入）',
  subtitle_url        VARCHAR(1024) NULL     COMMENT '字幕 SRT 文件 OSS 地址',
  subtitles_json_url  VARCHAR(1024) NULL     COMMENT '字幕 JSON 文件 OSS 地址',
  fail_message        TEXT          NULL     COMMENT '识别失败原因',
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (episode_id),
  UNIQUE KEY uk_clip_episode_drama_no (drama_id, episode_no),
  KEY idx_clip_episode_drama (drama_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='剧目分集表';

-- -----------------------------------------------------------------------------
-- clip_task: 剪辑任务
-- 说明: 核心任务表。single=单集直剪; episode_asr=仅识别入库; drama_mix=跨集混剪; drama_package=整包下载处理; output_asr=成片仅 ASR
-- -----------------------------------------------------------------------------
CREATE TABLE clip_task (
  task_id                 VARCHAR(64) NOT NULL COMMENT '任务 ID，如 task-a1b2c3d4',
  template_id             VARCHAR(64) NOT NULL DEFAULT 'vertical_hook_60s' COMMENT 'FFmpeg 渲染模板 ID',
  task_kind               ENUM('single','episode_asr','drama_mix','drama_package','output_asr','remix_replica') NOT NULL DEFAULT 'single'
                          COMMENT 'single=单集直剪; episode_asr=仅 ASR 入库; drama_mix=跨集混剪; drama_package=整包下载处理; output_asr=成片仅 ASR; remix_replica=案例视频复刻',
  status                  ENUM('pending','claimed','processing','completed','failed') NOT NULL DEFAULT 'pending'
                          COMMENT 'pending=待领取; claimed=已领取; processing=处理中; completed=完成; failed=失败',
  source_url              VARCHAR(1024) NOT NULL COMMENT '源视频 URL',
  drama_id                VARCHAR(64)  NULL COMMENT '关联剧目 ID',
  drama_meta_json         JSON         NULL COMMENT '剧目元数据快照（title 等）',
  drama_package_json      JSON         NULL COMMENT '整包任务元数据（phase/packageName 等）',
  episode_id              VARCHAR(64)  NULL COMMENT '关联分集 ID（episode_asr 任务）',
  episode_no              INT UNSIGNED NULL COMMENT '集序号冗余字段，便于查询',
  parent_package_task_id  VARCHAR(64)  NULL COMMENT '所属整包任务 ID（子任务不单独被 Agent 领取）',
  asr_rule_set_id         VARCHAR(64)  NULL COMMENT '任务使用的 ASR 规则集 ID',
  config_version          VARCHAR(64)  NULL COMMENT '任务创建时的全局 config_version 快照',
  claimed_by              CHAR(36)     NULL COMMENT '领取任务的设备 ID',
  claimed_at              DATETIME(3)  NULL COMMENT '任务被 Agent 领取的时间',
  processing_started_at   DATETIME(3)  NULL COMMENT 'Agent 开始处理（ASR/渲染）时间',
  processing_completed_at DATETIME(3)  NULL COMMENT '任务完成时间',
  total_wall_time_sec     DECIMAL(10,1) NULL COMMENT '识别到成片总耗时（秒）',
  output_url              VARCHAR(1024) NULL COMMENT '主成片 URL（单任务或混剪第一条）',
  fail_message            TEXT         NULL COMMENT '失败原因',
  plan_json               JSON         NULL COMMENT '当前 ClipPlan 剪辑方案 JSON',
  plan_batches_json       JSON         NULL COMMENT '混剪多轮 ClipPlanBatch[] JSON',
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '任务创建时间',
  updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (task_id),
  KEY idx_clip_task_status (status, updated_at),
  KEY idx_clip_task_drama (drama_id),
  KEY idx_clip_task_device (claimed_by),
  KEY idx_clip_task_kind_updated (task_kind, updated_at),
  KEY idx_clip_task_parent (parent_package_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='剪辑任务表';

-- -----------------------------------------------------------------------------
-- clip_remix_job: 案例复刻任务扩展表
-- 说明: 主任务复用 clip_task（task_kind=remix_replica），本表存案例视频与裂变配置
-- -----------------------------------------------------------------------------
CREATE TABLE clip_remix_job (
  job_id                  VARCHAR(64)     NOT NULL COMMENT '复刻任务 ID，与 clip_task.task_id 一致',
  drama_id                VARCHAR(64)     NULL COMMENT '关联短剧 ID（入库后回填）',
  intake_id               VARCHAR(64)     NULL COMMENT '关联短剧入库记录 ID（新短剧复刻等待入库时用）',
  external_drama_id       VARCHAR(255)    NULL COMMENT '外部平台短剧 ID（新短剧复刻等待入库时用）',
  parent_package_task_id  VARCHAR(64)     NULL COMMENT '新剧入库任务 ID，Agent 需等待该任务完成后拿到分集再复刻',
  case_video_url          VARCHAR(1024)   NOT NULL COMMENT '案例视频 TOS URL（首条）',
  case_video_urls         JSON            NULL COMMENT '案例视频 URL 列表（首条与 case_video_url 一致）',
  episode_urls            JSON            NOT NULL COMMENT '参与匹配的原片分集 URL 列表',
  status                  ENUM('pending','claimed','analyzing','rendering','uploading','completed','failed','waiting_intake') NOT NULL DEFAULT 'pending'
                          COMMENT 'pending=待领取; claimed=已领取; analyzing=视觉匹配中; rendering=渲染中; uploading=上传中; completed=完成; failed=失败; waiting_intake=等待新剧入库',
  timeline_json           JSON            NULL COMMENT '视觉指纹匹配时间线结果',
  output_url              VARCHAR(1024)   NULL COMMENT '成片 TOS URL',
  error_message           TEXT            NULL COMMENT '失败原因',
  device_id               CHAR(36)        NULL COMMENT '领取任务的客户端设备 ID',
  claimed_at              DATETIME(3)     NULL COMMENT '任务被客户端领取时间',
  completed_at            DATETIME(3)     NULL COMMENT '任务完成时间',
  fission_enabled         TINYINT         NOT NULL DEFAULT 0 COMMENT '是否启用裂变',
  fission_ops             JSON            NULL COMMENT '裂变操作维度列表',
  fission_count           INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '每个成片裂变数量',
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '最后更新时间',
  PRIMARY KEY (job_id),
  KEY idx_clip_remix_job_drama_status (drama_id, status, updated_at),
  KEY idx_clip_remix_job_status_created (status, created_at),
  KEY idx_clip_remix_job_intake (intake_id, status),
  KEY idx_clip_remix_job_external (external_drama_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='短剧案例视频复刻任务扩展表';

-- -----------------------------------------------------------------------------
-- clip_package_cache: Agent 本地 ZIP/解压缓存元数据（文件不上传服务端）
-- -----------------------------------------------------------------------------
CREATE TABLE clip_package_cache (
  cache_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '缓存记录主键',
  cache_key VARCHAR(128) NOT NULL COMMENT '稳定缓存键，同一剧目和剧包版本唯一',
  drama_id VARCHAR(64) NOT NULL COMMENT '剧目 ID，关联 clip_drama',
  package_task_id VARCHAR(64) NULL COMMENT '最近使用的剧包任务 ID，关联 clip_task',
  package_object_key VARCHAR(512) NULL COMMENT 'TOS/OSS 剧包对象键',
  package_name VARCHAR(255) NOT NULL COMMENT 'ZIP 文件名',
  device_id CHAR(36) NOT NULL COMMENT '缓存所在 Agent 设备 ID，关联 clip_device',
  zip_path VARCHAR(1024) NULL COMMENT 'Agent 本地 ZIP 绝对路径',
  extract_path VARCHAR(1024) NULL COMMENT 'Agent 本地解压目录绝对路径',
  zip_exists TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'ZIP 是否存在：1=是，0=否',
  extracted TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否完成解压并发现视频：1=是，0=否',
  episode_count INT UNSIGNED NULL COMMENT '扫描到的可处理视频集数',
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '缓存占用空间（字节）',
  status ENUM('missing','downloading','ready','stale','deleting','delete_failed') NOT NULL DEFAULT 'missing' COMMENT '缓存状态：missing=缺失; downloading=下载中; ready=可复用; stale=待复核; deleting=删除中; delete_failed=删除失败',
  last_used_at DATETIME(3) NULL COMMENT '最近使用或复用时间',
  last_error TEXT NULL COMMENT '最近缓存错误',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (cache_id) COMMENT '缓存主键索引',
  UNIQUE KEY uk_package_cache_key_device (cache_key, device_id) COMMENT '设备内缓存键唯一',
  KEY idx_package_cache_drama (drama_id, updated_at) COMMENT '按剧目查询缓存',
  KEY idx_package_cache_device (device_id, status) COMMENT '按设备和状态查询缓存'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Agent 本地剧包缓存元数据';

CREATE TABLE clip_package_cache_event (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '缓存事件主键',
  cache_id BIGINT UNSIGNED NOT NULL COMMENT '关联 clip_package_cache.cache_id',
  event_type VARCHAR(32) NOT NULL COMMENT '事件类型：discovered/downloaded/reused/extracted/deleted/delete_failed',
  detail_json JSON NULL COMMENT '事件上下文、耗时、错误和扫描集数',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '事件时间',
  PRIMARY KEY (event_id) COMMENT '事件主键索引',
  KEY idx_package_cache_event (cache_id, created_at) COMMENT '按缓存和时间查询事件',
  CONSTRAINT fk_package_cache_event_cache FOREIGN KEY (cache_id) REFERENCES clip_package_cache(cache_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='剧包缓存生命周期事件';

CREATE TABLE clip_edit_marker (
  marker_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '人工高光/剪辑标记主键',
  task_id VARCHAR(64) NULL COMMENT '关联任务 ID',
  source_path VARCHAR(1024) NOT NULL COMMENT 'Agent 本地源文件路径',
  device_id CHAR(36) NOT NULL COMMENT '标记所在 Agent 设备 ID',
  start_ms BIGINT UNSIGNED NOT NULL COMMENT '标记起点（毫秒）',
  end_ms BIGINT UNSIGNED NOT NULL COMMENT '标记终点（毫秒）',
  label VARCHAR(64) NOT NULL DEFAULT '高光' COMMENT '标记名称',
  highlight_type VARCHAR(16) NULL COMMENT '高光类型 hook/conflict/twist/cliff（与 ASR 一致）',
  usable_as_hook TINYINT(1) NULL COMMENT '是否适合作投放片头',
  source VARCHAR(32) NOT NULL DEFAULT 'human' COMMENT '标记来源：human=人工，model=模型',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (marker_id) COMMENT '标记主键索引',
  KEY idx_edit_marker_source (device_id, source_path(700), start_ms) COMMENT '按设备和源文件前缀查询标记，避免 utf8mb4 索引超长',
  KEY idx_edit_marker_task (task_id, created_at) COMMENT '按任务查询标记'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='短剧人工高光和剪辑标记';

-- -----------------------------------------------------------------------------
-- clip_task_mix_episode: 混剪任务与分集关联
-- 说明: drama_mix 任务包含哪些已识别完成的分集
-- -----------------------------------------------------------------------------
CREATE TABLE clip_task_mix_episode (
  task_id     VARCHAR(64) NOT NULL COMMENT '混剪任务 ID',
  episode_id  VARCHAR(64) NOT NULL COMMENT '参与混剪的分集 ID',
  sort_order  INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '分集在混剪中的排序',
  PRIMARY KEY (task_id, episode_id),
  KEY idx_clip_mix_task (task_id),
  KEY idx_clip_mix_episode (episode_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='混剪任务与分集关联表';

-- -----------------------------------------------------------------------------
-- clip_asr_result: ASR 识别结果摘要
-- 说明: Agent 提交 POST /agent/tasks/:id/asr-result 后写入；与 task 一一对应，持久保留
-- -----------------------------------------------------------------------------
CREATE TABLE clip_asr_result (
  task_id               VARCHAR(64) NOT NULL COMMENT '任务 ID，主键，关联 clip_task',
  drama_id              VARCHAR(64) NULL COMMENT '剧目 ID 冗余',
  episode_id            VARCHAR(64) NULL COMMENT '分集 ID 冗余',
  episode_no            INT UNSIGNED NULL COMMENT '集序号冗余',
  task_kind             ENUM('single','episode_asr','drama_mix','drama_package','output_asr','remix_replica') NOT NULL DEFAULT 'single' COMMENT '任务类型冗余',
  device_id             CHAR(36)    NULL COMMENT '提交 ASR 结果的设备 ID',
  source_url            VARCHAR(1024) NULL COMMENT '源视频 URL 冗余',
  asr_rule_set_id       VARCHAR(64) NULL COMMENT '使用的 ASR 规则集 ID',
  rule_set_version      VARCHAR(32) NULL COMMENT '规则集版本号快照',
  raw_segment_count     INT UNSIGNED NULL COMMENT 'FunASR 原始段数量',
  final_segment_count   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '规则引擎输出的最终段数量',
  full_text             MEDIUMTEXT  NULL COMMENT '全部句级片段文本拼接，便于全文检索',
  subtitle_url          VARCHAR(1024) NULL COMMENT '字幕 SRT OSS 地址',
  subtitles_json_url    VARCHAR(1024) NULL COMMENT '字幕 JSON OSS 地址',
  saved_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '首次 ASR 入库时间',
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'ASR 结果最后更新时间（重识别会更新）',
  PRIMARY KEY (task_id),
  KEY idx_clip_asr_result_drama (drama_id, episode_no),
  KEY idx_clip_asr_result_episode (episode_id),
  KEY idx_clip_asr_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ASR 识别结果摘要表';

-- -----------------------------------------------------------------------------
-- clip_asr_segment: ASR 处理后句级片段
-- 说明: 规则引擎输出，供本地选段方案引用；每条一行，便于按文本/时间查询
-- -----------------------------------------------------------------------------
CREATE TABLE clip_asr_segment (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  task_id       VARCHAR(64)     NOT NULL COMMENT '所属任务 ID，关联 clip_asr_result',
  segment_id    VARCHAR(64)     NOT NULL COMMENT '片段 ID，如 s001，剪辑方案引用',
  sort_order    INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '片段在任务内的顺序（从 0 起）',
  start_ms      INT UNSIGNED    NOT NULL COMMENT '片段起始时间（毫秒）',
  end_ms        INT UNSIGNED    NOT NULL COMMENT '片段结束时间（毫秒）',
  speech_start_ms INT UNSIGNED  NULL COMMENT '真实开口时间（毫秒）；连续化前 ASR 首音起点',
  duration_ms   INT UNSIGNED    GENERATED ALWAYS AS (end_ms - start_ms) STORED COMMENT '片段时长（毫秒，自动计算）',
  text          TEXT            NOT NULL COMMENT '识别文本（句级，已 ITN/去 filler）',
  confidence    DECIMAL(6,4)    NULL COMMENT '识别置信度 0~1',
  episode_id    VARCHAR(64)     NULL COMMENT '跨集混剪时片段来源分集 ID',
  episode_no    INT UNSIGNED    NULL COMMENT '跨集混剪时片段来源集序号',
  highlight_type VARCHAR(16)    NULL COMMENT '高光类型 hook/conflict/twist/cliff（台词启发式）',
  highlight_score SMALLINT      NULL COMMENT '高光分',
  highlight_tags VARCHAR(255)   NULL COMMENT '高光标签，逗号分隔',
  usable_as_hook TINYINT(1)     NULL COMMENT '是否适合作投放片头',
  speaker_id    VARCHAR(64)     NULL COMMENT '说话人ID（声纹/diarization；无模型时为空）',
  emotion       VARCHAR(32)     NULL COMMENT '情绪标签（当前文本启发式）',
  scene_type    VARCHAR(32)     NULL COMMENT '场面类型（当前文本推断，非真实画面）',
  label_source  VARCHAR(64)     NULL COMMENT '标签来源',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_clip_asr_segment (task_id, segment_id),
  KEY idx_clip_asr_segment_task (task_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ASR 处理后句级片段表';

-- -----------------------------------------------------------------------------
-- clip_asr_raw_segment: ASR 原始片段
-- 说明: FunASR 直出段，规则引擎处理前的原始数据，可选存储
-- -----------------------------------------------------------------------------
CREATE TABLE clip_asr_raw_segment (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  task_id       VARCHAR(64)     NOT NULL COMMENT '所属任务 ID，关联 clip_asr_result',
  raw_id        VARCHAR(64)     NOT NULL COMMENT 'FunASR 原始段 ID',
  sort_order    INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '原始段顺序',
  start_ms      INT UNSIGNED    NOT NULL COMMENT '起始时间（毫秒）',
  end_ms        INT UNSIGNED    NOT NULL COMMENT '结束时间（毫秒）',
  text          TEXT            NOT NULL COMMENT '原始识别文本',
  confidence    DECIMAL(6,4)    NULL COMMENT '原始置信度 0~1',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_clip_asr_raw_segment (task_id, raw_id),
  KEY idx_clip_asr_raw_task (task_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ASR 原始片段表（FunASR 直出）';

-- -----------------------------------------------------------------------------
-- clip_mix_render: 混剪成片记录
-- 说明: drama_mix 任务每轮每条方案渲染出的 mp4
-- -----------------------------------------------------------------------------
CREATE TABLE clip_mix_render (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  task_id         VARCHAR(64)     NOT NULL COMMENT '混剪任务 ID',
  round_no        INT UNSIGNED    NOT NULL DEFAULT 1 COMMENT '混剪轮次（第几轮选段）',
  plan_index      INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '该轮内方案序号（0 起）',
  output_url      VARCHAR(1024)   NOT NULL COMMENT '成片 OSS URL',
  strategy        VARCHAR(64)     NULL COMMENT '投放策略，如 suspense_hook',
  duration_tier   ENUM('S','M','L','XL') NULL COMMENT '时长档 S=12-22s M=25-40s L=45-75s XL=75-90s',
  narrative_line  VARCHAR(512)    NULL COMMENT '一句话叙事线说明',
  meta_json       JSON            NULL COMMENT 'editForm/genreProfile/localOutputPath 等扩展',
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '渲染完成时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_clip_mix_render (task_id, round_no, plan_index),
  KEY idx_clip_mix_render_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='混剪任务成片记录表';

-- -----------------------------------------------------------------------------
-- clip_task_output: 单任务成片输出
-- 说明: single 类型任务渲染出的 mp4，支持多输出扩展
-- -----------------------------------------------------------------------------
CREATE TABLE clip_task_output (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  task_id         VARCHAR(64)     NOT NULL COMMENT '任务 ID',
  output_url      VARCHAR(1024)   NOT NULL COMMENT '成片 OSS URL',
  sort_order      INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '同一任务多成片的排序',
  file_sha256     CHAR(64)        NULL COMMENT '文件 SHA256（预留校验）',
  duration_sec    DECIMAL(10,2)   NULL COMMENT '成片时长（秒）',
  file_bytes      BIGINT UNSIGNED NULL COMMENT '文件大小（字节）',
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入库时间',
  PRIMARY KEY (id),
  KEY idx_clip_task_output_task (task_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='单任务成片输出表';

-- -----------------------------------------------------------------------------
-- clip_drama_package_name_index: 整包 zip 命名 dedup 序号
-- -----------------------------------------------------------------------------
CREATE TABLE clip_drama_package_name_index (
  safe_title VARCHAR(255) NOT NULL COMMENT '剧目标题安全化后的 key',
  last_seq     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '该标题已分配的最大 dedup 序号',
  PRIMARY KEY (safe_title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='整包 zip 命名 dedup 序号索引';

-- -----------------------------------------------------------------------------
-- clip_telemetry_batch: 遥测上报批次
-- 说明: Agent 上报 POST /agent/telemetry/events 时的一个批次头
-- -----------------------------------------------------------------------------
CREATE TABLE clip_telemetry_batch (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '批次自增 ID',
  device_id            CHAR(36)        NOT NULL COMMENT '上报设备 ID',
  task_id              VARCHAR(64)     NOT NULL COMMENT '关联任务 ID',
  config_version       VARCHAR(64)     NOT NULL DEFAULT '' COMMENT '上报时的 config_version',
  asr_rule_set_id      VARCHAR(64)     NULL COMMENT '上报时的 ASR 规则集 ID',
  asr_rule_set_version VARCHAR(32)     NULL COMMENT '上报时的规则集版本',
  created_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '服务端接收时间',
  PRIMARY KEY (id),
  KEY idx_clip_telemetry_batch_device (device_id, created_at),
  KEY idx_clip_telemetry_batch_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='遥测上报批次表';

-- -----------------------------------------------------------------------------
-- clip_telemetry_event: 遥测事件明细
-- 说明: 批次内各事件，type 如 asr.completed / render.completed / task.completed
-- -----------------------------------------------------------------------------
CREATE TABLE clip_telemetry_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '事件自增 ID',
  batch_id      BIGINT UNSIGNED NOT NULL COMMENT '所属批次 ID',
  event_type    VARCHAR(64)     NOT NULL COMMENT '事件类型：asr.completed|render.completed|task.completed|task.failed 等',
  event_at      DATETIME(3)     NOT NULL COMMENT '事件发生时间（Agent 上报）',
  metrics_json  JSON            NOT NULL COMMENT '事件指标 JSON（audioDurationSec/wallTimeSec/outputBytes 等）',
  PRIMARY KEY (id),
  KEY idx_clip_telemetry_event_batch (batch_id),
  KEY idx_clip_telemetry_event_type (event_type, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='遥测事件明细表';

-- -----------------------------------------------------------------------------
-- clip_device_daily_stats: 设备日报聚合
-- 说明: 管理台「设备日报」按天按设备汇总任务/ASR/渲染用量
-- -----------------------------------------------------------------------------
CREATE TABLE clip_device_daily_stats (
  stat_date               DATE NOT NULL COMMENT '统计日期 YYYY-MM-DD',
  device_id               CHAR(36) NOT NULL COMMENT '设备 ID',
  task_count              INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当日任务总数',
  task_success            INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当日成功任务数',
  task_fail               INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当日失败任务数',
  asr_audio_sec_total     DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'ASR 处理音频总时长（秒）',
  asr_wall_sec_total      DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'ASR 实际耗时总和（秒）',
  asr_job_count           INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ASR 任务次数',
  render_output_sec_total DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '渲染成片总时长（秒）',
  render_wall_sec_total   DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '渲染实际耗时总和（秒）',
  render_bytes_total      BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '渲染输出总字节数',
  updated_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '聚合最后更新时间',
  PRIMARY KEY (stat_date, device_id),
  KEY idx_clip_daily_stats_device (device_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='设备日报聚合统计表';

-- =============================================================================
-- 种子数据（首次初始化默认值，重复执行不会覆盖已有业务数据的关键字段）
-- =============================================================================

INSERT INTO clip_asr_rule_set (rule_set_id, rule_set_version, rules_json)
VALUES (
  'drama-default-v1', '1.1.0',
  JSON_OBJECT(
    'ruleSetId', 'drama-default-v1', 'ruleSetVersion', '1.1.0',
    'pipeline', JSON_OBJECT('enableVad', TRUE, 'enablePunc', TRUE, 'sentenceLevel', TRUE),
    'vad', JSON_OBJECT('minSpeechMs', 300, 'mergeGapMs', 1800),
    'merge', JSON_OBJECT('minGapMs', 800, 'maxSentenceMs', 20000, 'splitOnPunc', JSON_ARRAY('。', '？', '！', '…', '!', '?')),
    'filter', JSON_OBJECT('minSegmentMs', 800, 'maxSegmentMs', 30000, 'minConfidence', 0.6, 'dropEmptyText', TRUE, 'dropFillersOnly', TRUE),
    'hotwords', JSON_OBJECT('version', '20260605', 'items', JSON_ARRAY()),
    'text', JSON_OBJECT('enableItn', TRUE, 'trimWhitespace', TRUE, 'removeFillers', JSON_ARRAY('嗯', '啊', '呃')),
    'output', JSON_OBJECT('segmentIdPrefix', 's', 'maxSegments', 500)
  )
) ON DUPLICATE KEY UPDATE rules_json = VALUES(rules_json), updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO clip_drama (drama_id, title, asr_rule_set_id)
VALUES ('drama-demo', '演示短剧', 'drama-default-v1')
ON DUPLICATE KEY UPDATE title = VALUES(title), updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO clip_config_profile (profile_key, config_version, profile_json, is_active)
VALUES (
  'gpu_4060_standard', 'cfg-seed-001',
  JSON_OBJECT(
    'profile', 'gpu_4060_standard', 'configVersion', 'cfg-seed-001',
    'services', JSON_OBJECT('agentEnabled', TRUE, 'taskProcessing', TRUE, 'asrSidecar', TRUE),
    'asr', JSON_OBJECT(
      'models', JSON_OBJECT('asr', 'paraformer-zh', 'vad', 'fsmn-vad', 'punc', 'ct-punc'),
      'runtime', JSON_OBJECT('device', 'cuda:0', 'maxSingleSegmentMs', 60000, 'batchSizeSec', 30)
    ),
    'render', JSON_OBJECT(
      'encode', JSON_OBJECT('codec', 'h264_nvenc', 'preset', 'p4', 'cq', 23),
      'limits', JSON_OBJECT('maxDurationSec', 1200, 'maxConcurrentRenders', 2, 'maxConcurrentUploads', 2, 'llmRenderPipeline', TRUE, 'uploadAfterRender', FALSE, 'localOutputDir', 'D:/ClipOutput'),
      'workspaceMaxGb', 50
    )
  ), 1
) ON DUPLICATE KEY UPDATE profile_json = VALUES(profile_json), updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO clip_bgm_settings (settings_id, enabled, volume, fade_in_sec, fade_out_sec, loop_enabled)
VALUES (1, 0, 0.250, 1.00, 2.00, 1)
ON DUPLICATE KEY UPDATE settings_id = settings_id;

INSERT INTO clip_agent_update_manifest (platform, version, download_url, sha256, mandatory, release_notes)
VALUES ('win-x64-4060', '0.3.0', 'https://clip-cdn.example.com/agent/ClipAgent-0.3.0-x64.msi', '0000000000000000000000000000000000000000000000000000000000000000', 0, 'MVP 完整功能版本')
ON DUPLICATE KEY UPDATE version = VALUES(version), updated_at = CURRENT_TIMESTAMP(3);
