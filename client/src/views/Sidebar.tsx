import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Site, User } from "../../../src/api/types";
import { BRAND_NAME } from "../../../src/brand";
import { BrandLogo, BrandMark } from "../brand";
import {
  ArticleIcon,
  ChartIcon,
  CloseIcon,
  ImportIcon,
  LogoutIcon,
  MemoIcon,
  MenuIcon,
  SettingsIcon,
  SitesIcon,
  UsersIcon,
} from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadSites, useView } from "../load";
import {
  type GlobalNavItemId,
  type SiteNavItemId,
  SITE_NAV,
  ariaCurrentForGlobal,
  ariaCurrentForSite,
  currentSiteNavItem,
  globalNavFor,
  siteOfRoute,
} from "../nav";
import { type Route, navigate } from "../router";
import { setCurrentSite, useCurrentSite, useSitesVersion } from "../siteContext";

// Wide screens show the sidebar; narrow ones show a top bar whose button opens the same content in a drawer.
// Keep in sync with the (width >= 1024px) rules in styles.css.
const WIDE_QUERY = "(width >= 1024px)";

const SITE_ICONS: Record<SiteNavItemId, () => ReactNode> = {
  performance: ChartIcon,
  articles: ArticleIcon,
  memos: MemoIcon,
  data: ImportIcon,
  settings: SettingsIcon,
};

const GLOBAL_ICONS: Record<GlobalNavItemId, () => ReactNode> = {
  sites: SitesIcon,
  users: UsersIcon,
};

// The frame around every screen once the signed-in user is known.
export function AppShell({
  client,
  user,
  route,
  path,
  children,
}: {
  client: ApiClient;
  user: User;
  route: Route;
  path: string;
  children: ReactNode;
}) {
  const drawerId = useId();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closedByWidth = useRef(false);
  const lastPath = useRef(path);
  const version = useSitesVersion();
  const [sitesState] = useView(() => loadSites(client), `shell-sites:${version}`);
  const sites = sitesState.kind === "ready" ? sitesState.data : [];
  const routeSite = siteOfRoute(route);
  const stored = useCurrentSite();
  const siteId = routeSite ?? stored;
  const site = sites.find((candidate) => candidate.id === siteId) ?? null;

  useEffect(() => {
    if (routeSite !== null) setCurrentSite(routeSite);
  }, [routeSite]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    if (dialogRef.current?.open) dialogRef.current.close();
  }, [path]);

  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    function onChange() {
      const dialog = dialogRef.current;
      if (!query.matches || !dialog?.open) return;
      closedByWidth.current = true;
      dialog.close();
    }
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  function onClose() {
    setOpen(false);
    if (closedByWidth.current) {
      closedByWidth.current = false;
      return;
    }
    menuButtonRef.current?.focus();
  }

  function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }

  function onContentClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("a") !== null) dialogRef.current?.close();
  }

  const content = <SidebarContent user={user} route={route} sites={sites} site={site} />;

  return (
    <div className="shell">
      <aside className="rail" aria-label="ナビゲーション">
        {content}
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <button
            ref={menuButtonRef}
            type="button"
            className="icon-button"
            aria-label="メニュー"
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setOpen(true)}
          >
            <MenuIcon />
          </button>
          <Link to="/" className="brand">
            <BrandMark />
            <span className="sr-only">{BRAND_NAME}</span>
          </Link>
          {site !== null && <span className="topbar-site">{site.name}</span>}
        </header>
        {children}
      </div>
      <dialog ref={dialogRef} id={drawerId} className="drawer" aria-label="メニュー" onClose={onClose} onClick={onDialogClick}>
        {open && (
          <div className="drawer-content" onClick={onContentClick}>
            <button
              ref={closeButtonRef}
              type="button"
              className="icon-button drawer-close"
              aria-label="メニューを閉じる"
              onClick={() => dialogRef.current?.close()}
            >
              <CloseIcon />
            </button>
            {content}
          </div>
        )}
      </dialog>
    </div>
  );
}

function SidebarContent({ user, route, sites, site }: { user: User; route: Route; sites: Site[]; site: Site | null }) {
  const name = user.name ?? user.email;
  return (
    <div className="rail-content">
      <Link to="/" className="brand">
        <BrandLogo />
        <span className="sr-only">{BRAND_NAME}</span>
      </Link>
      {sites.length > 0 && <SiteSwitcher sites={sites} site={site} route={route} />}
      {site !== null && (
        <nav className="nav" aria-label={`${site.name} の画面`}>
          <ul className="nav-list">
            {SITE_NAV.map((item) => {
              const ItemIcon = SITE_ICONS[item.id];
              return (
                <li key={item.id}>
                  <Link to={item.path(site.id)} className="nav-link" aria-current={ariaCurrentForSite(route, item.id)}>
                    <ItemIcon />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      <nav className="nav nav-global" aria-label="全体">
        <ul className="nav-list">
          {globalNavFor(user.role).map((item) => {
            const ItemIcon = GLOBAL_ICONS[item.id];
            return (
              <li key={item.id}>
                <Link to={item.to} className="nav-link" aria-current={ariaCurrentForGlobal(route, item.id)}>
                  <ItemIcon />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="account">
        <span className="avatar" aria-hidden="true">
          {Array.from(name)[0]?.toUpperCase()}
        </span>
        <span className="account-text">
          <span className="account-name">{name}</span>
          <span className="account-role">{user.role === "admin" ? "管理者" : "メンバー"}</span>
        </span>
        <form method="post" action="/auth/logout">
          <button type="submit" className="icon-button" aria-label="ログアウト" title="ログアウト">
            <LogoutIcon />
          </button>
        </form>
      </div>
    </div>
  );
}

// The site the screens are about. Choosing another site keeps the kind of screen (the memos of the other site).
function SiteSwitcher({ sites, site, route }: { sites: Site[]; site: Site | null; route: Route }) {
  const item = currentSiteNavItem(route) ?? "performance";
  const target = SITE_NAV.find((candidate) => candidate.id === item) ?? SITE_NAV[0];
  return (
    <label className="switcher">
      <span className="switcher-label">サイト</span>
      <select
        className={site === null ? "switcher-empty" : undefined}
        value={site?.id ?? ""}
        onChange={(event) => {
          const id = event.target.value;
          if (id === "" || target === undefined) return;
          setCurrentSite(id);
          navigate(target.path(id));
        }}
      >
        {site === null && <option value="">サイトを選ぶ</option>}
        {sites.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name}
          </option>
        ))}
      </select>
    </label>
  );
}
