import { version as appVersion } from "../../../package.json";
import {
  ArrowUpRight,
  Database,
  Globe2,
  Scale,
  Terminal,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import type { LedgerSnapshot } from "../../shared/report";
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
}

export function AboutPage({
  onResolvedChange,
  mobileLayout,
  onMobileLayoutChange,
  mode,
}: AboutPageProps) {
  const [session, setSession] = useState<{ login: string } | null>(null);
  useEffect(() => {
    let active = true;
    readSession()
      .then((value) => active && setSession(value))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const modeLabel =
    mode === "live" ? "实时 API" : mode === "demo" ? "本地演示" : "尚未读取";

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
            {session && (
              <div>
                <dt>
                  <UserRound size={15} />
                  登录账号
                </dt>
                <dd className="about-page-session">
                  <span>{session.login}</span>
                  <a className="about-page-link" href="/auth/logout">
                    退出登录
                  </a>
                </dd>
              </div>
            )}
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
        </section>
      </div>
    </section>
  );
}

/** 只有服务端开启 GitHub 登录时才有账号；未开启或演示环境返回 null，不显示退出入口。 */
async function readSession(): Promise<{ login: string } | null> {
  const response = await fetch("/auth/session", {
    credentials: "same-origin",
    redirect: "manual",
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { login?: unknown };
  return typeof body.login === "string" ? { login: body.login } : null;
}
