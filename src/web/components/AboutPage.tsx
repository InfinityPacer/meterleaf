import { version as appVersion } from "../../../package.json";
import {
  ArrowUpRight,
  BookOpen,
  Database,
  Globe2,
  Scale,
  Terminal,
} from "lucide-react";
import type { ComponentProps } from "react";
import type { LedgerSnapshot, UsdBasis } from "../../shared/report";
import { ThemeControl } from "./ThemeControl";
import "./about-page.css";

type ThemeControlProps = ComponentProps<typeof ThemeControl>;

/** About 页所需的显示状态；主题交互沿用共享 ThemeControl。 */
export interface AboutPageProps extends Pick<
  ThemeControlProps,
  "onResolvedChange" | "mobileLayout" | "onMobileLayoutChange"
> {
  /** 当前账本使用的数据来源模式；首个快照尚未到达时可以缺省。 */
  mode?: LedgerSnapshot["mode"];
  /** 当前页面使用的 USD 估算口径。 */
  usdBasis: UsdBasis;
}

export function AboutPage({
  onResolvedChange,
  mobileLayout,
  onMobileLayoutChange,
  mode,
  usdBasis,
}: AboutPageProps) {
  const modeLabel =
    mode === "live" ? "实时 API" : mode === "demo" ? "本地演示" : "尚未读取";
  const usdBasisLabel = usdBasis === "subscription" ? "订阅等价" : "标准 API";

  return (
    <section className="about-page" aria-labelledby="about-page-title">
      <header className="about-page-header">
        <div className="about-page-brand">
          <img
            className="about-page-brand-icon"
            src="/favicon.svg"
            width="48"
            height="48"
            alt=""
          />
          <div className="about-page-brand-copy">
            <div className="about-page-brand-line">
              <h2 id="about-page-title">Meterleaf</h2>
              <span className="about-page-version">v{appVersion}</span>
            </div>
            <p>独立 AI 用量账本</p>
          </div>
        </div>
      </header>

      <div className="about-page-columns">
        <section
          className="about-page-section about-page-preferences"
          aria-labelledby="about-page-preferences-title"
        >
          <h3 id="about-page-preferences-title" className="sr-only">
            偏好
          </h3>
          <ThemeControl
            inline
            onResolvedChange={onResolvedChange}
            mobileLayout={mobileLayout}
            onMobileLayoutChange={onMobileLayoutChange}
          />
        </section>

        <section
          className="about-page-section about-page-product"
          aria-labelledby="about-page-product-title"
        >
          <div className="about-page-section-heading">
            <h3 id="about-page-product-title">产品信息</h3>
          </div>
          <dl className="about-page-details">
            <div>
              <dt>
                <Database size={15} />
                数据模式
              </dt>
              <dd>{modeLabel}</dd>
            </div>
            <div>
              <dt>
                <BookOpen size={15} />
                USD 估算口径
              </dt>
              <dd>{usdBasisLabel}</dd>
            </div>
            <div>
              <dt>
                <Scale size={15} />
                许可证
              </dt>
              <dd>Apache-2.0</dd>
            </div>
            <div>
              <dt>
                <ArrowUpRight size={15} />
                GitHub
              </dt>
              <dd>
                <a
                  className="about-page-link"
                  href="https://github.com/InfinityPacer/meterleaf"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>InfinityPacer/meterleaf</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </dd>
            </div>
            <div>
              <dt>
                <Terminal size={15} />
                运行时
              </dt>
              <dd>Bun</dd>
            </div>
            <div>
              <dt>
                <Globe2 size={15} />
                时区
              </dt>
              <dd>Asia/Shanghai</dd>
            </div>
          </dl>

          <div className="about-page-pricing">
            <h4>计价说明</h4>
            <p>
              订阅等价不加收长上下文费用，标准 API
              按公开费率估算，七天额度按本周期消费与已用比例预估。
            </p>
          </div>
        </section>
      </div>
    </section>
  );
}
