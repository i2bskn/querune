import { type FormEvent, useRef, useState } from "react";
import type { Invitation, User } from "../../../src/api/types";
import {
  type UserActionResult,
  changeUserRole,
  createUser,
  deleteUser,
  reissueUserInvitation,
  resetUserMfa,
  resetUserPassword,
  revokeUserSessions,
} from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { type ApiClient, type UsersData, loadUsersView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";

type Role = User["role"];
type AuthMode = UsersData["authMode"];
type Operation = "role" | "password" | "invitation" | "mfa" | "logout" | "delete";
// How a user added in password mode gets their password: an invitation link to set it themselves, or an initial
// password chosen by the admin.
type PasswordMethod = "invite" | "password";

const ROLE_LABELS: Record<Role, string> = { admin: "管理者", member: "メンバー" };
const GONE_MESSAGE = "このユーザーは見つかりません。削除された可能性があります";
const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";

// The screen for admins to manage users. The server checks the role again; a member who opens the URL
// sees its 403 message. currentUserId is the signed-in user, who cannot delete or sign out themselves here.
export function UsersView({ client, currentUserId }: { client: ApiClient; currentUserId: string }) {
  const [state, reload] = useView(() => loadUsersView(client), "users");
  // The result of the last operation, shown above the list until the next one. It stays across the reload
  // that follows, which may remove the row the operation was opened from.
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The invitation link of the user just added. It is returned only once, so it stays until closed, across the
  // reload that follows.
  const [createdInvitation, setCreatedInvitation] = useState<Invitation | null>(null);
  useDocumentTitle(viewTitle(state, () => "ユーザー"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const { users, authMode } = state.data;

  return (
    <main className="page">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">管理</p>
          <h1>ユーザー</h1>
          <p className="lead">この Querune にログインできる人です。管理者はユーザーの追加と権限の変更ができます。</p>
        </div>
        {!adding && createdInvitation === null && (
          <button type="button" className="button-primary" onClick={() => setAdding(true)}>
            <PlusIcon />
            ユーザーを追加
          </button>
        )}
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {adding && (
        <CreateUserForm
          client={client}
          authMode={authMode}
          onClose={() => setAdding(false)}
          onCreated={(invitation) => {
            setAdding(false);
            setNotice(null);
            setCreatedInvitation(invitation);
            reload();
          }}
        />
      )}
      {createdInvitation !== null && (
        <InvitationLink invitation={createdInvitation} onClose={() => setCreatedInvitation(null)} />
      )}
      <ul className="users">
        {users.map((user) => (
          <UserRow
            key={user.id}
            client={client}
            user={user}
            authMode={authMode}
            isCurrentUser={user.id === currentUserId}
            isLastAdmin={user.role === "admin" && users.filter((other) => other.role === "admin").length === 1}
            onNotice={setNotice}
            onReload={reload}
          />
        ))}
      </ul>
    </main>
  );
}

// The form to add a user. In password mode the user gets an invitation link (the default) or an initial password;
// in OIDC mode no password is sent and the user signs in with the IdP.
function CreateUserForm({
  client,
  authMode,
  onClose,
  onCreated,
}: {
  client: ApiClient;
  authMode: AuthMode;
  onClose: () => void;
  // invitation is the link to show, null when the user was added with a password or in OIDC mode.
  onCreated: (invitation: Invitation | null) => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState<PasswordMethod>("invite");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const withPassword = authMode === "password" && method === "password";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    // A blank name is sent as null; the server also treats it as no name. Without a password, password mode
    // returns an invitation link.
    const result = await createUser(client, {
      email,
      name: name.trim() === "" ? null : name,
      role,
      ...(withPassword ? { password } : {}),
    });
    switch (result.kind) {
      case "ok":
        setSending(false);
        onCreated(result.invitation);
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  return (
    <form className="folder-form" aria-label="ユーザーを追加" onSubmit={(event) => void onSubmit(event)}>
      <label>
        メールアドレス
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="off"
          required
          disabled={sending}
        />
      </label>
      <label>
        名前（省略可）
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} disabled={sending} />
      </label>
      {authMode === "password" ? (
        <fieldset>
          <legend>パスワード</legend>
          <label className="check">
            <input
              type="radio"
              name="password-method"
              value="invite"
              checked={method === "invite"}
              onChange={() => setMethod("invite")}
              disabled={sending}
            />
            招待リンクを発行する
          </label>
          <label className="check">
            <input
              type="radio"
              name="password-method"
              value="password"
              checked={method === "password"}
              onChange={() => setMethod("password")}
              disabled={sending}
            />
            初期パスワードを設定する
          </label>
        </fieldset>
      ) : (
        <p className="hint">このメールアドレスで&nbsp;IdP&nbsp;にログインすると使えるようになります。</p>
      )}
      {authMode === "password" && method === "invite" && (
        <p className="hint">本人がリンクを開いて自分でパスワードを決めます。リンクは追加した後に表示されます。</p>
      )}
      {withPassword && (
        <label>
          パスワード（12&nbsp;文字以上）
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
            disabled={sending}
          />
        </label>
      )}
      <label>
        ロール
        <select value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={sending}>
          <option value="member">{ROLE_LABELS.member}</option>
          <option value="admin">{ROLE_LABELS.admin}</option>
        </select>
      </label>
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          追加
        </button>
        <button type="button" onClick={onClose} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

// An invitation link just issued. The server returns it only once, so it cannot be shown again after closing; a new
// one can be issued instead.
function InvitationLink({ invitation, onClose }: { invitation: Invitation; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  function copy() {
    // Without the clipboard (e.g. not a secure context), the link is selected to copy by hand.
    const select = () => input.current?.select();
    if (!navigator.clipboard) {
      select();
      return;
    }
    navigator.clipboard.writeText(invitation.url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      select,
    );
  }

  return (
    <div className="folder-form" role="group" aria-label="招待リンク">
      <p>
        招待リンクを発行しました。{formatDateTime(invitation.expires_at)}&nbsp;まで有効です。本人に渡してください。
      </p>
      <div className="invitation-link">
        <input
          ref={input}
          type="text"
          value={invitation.url}
          readOnly
          aria-label="招待リンク"
          onFocus={(event) => event.target.select()}
        />
        <button type="button" onClick={copy}>
          コピー
        </button>
      </div>
      <p className="hint">
        この表示を閉じるとリンクは再表示できません。必要になったら「招待リンクを再発行」で新しいリンクを発行できます。
      </p>
      <div className="folder-form-actions">
        <button type="button" onClick={onClose}>
          閉じる
        </button>
        <span className="hint" role="status">
          {copied ? "コピーしました" : ""}
        </span>
      </div>
    </div>
  );
}

// One user with the operations on them. One operation is open at a time.
function UserRow({
  client,
  user,
  authMode,
  isCurrentUser,
  isLastAdmin,
  onNotice,
  onReload,
}: {
  client: ApiClient;
  user: User;
  authMode: AuthMode;
  isCurrentUser: boolean;
  // The server refuses to make the last admin a member, so the button is not shown for them.
  isLastAdmin: boolean;
  onNotice: (notice: string | null) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<Operation | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  // The invitation link issued again from this row. Reissuing does not change the list, so the list is not reloaded
  // and the link stays until closed or another operation is opened.
  const [reissued, setReissued] = useState<Invitation | null>(null);

  const newRole: Role = user.role === "admin" ? "member" : "admin";
  // Resetting another user's password or MFA, and invitation links, are for password mode only; the current user
  // changes their own password and MFA elsewhere. The MFA state of a user is not in the API, so the reset is offered
  // for every other user; the server answers 409 for a user without MFA.
  const operations: Operation[] = [
    ...(isLastAdmin ? [] : (["role"] as const)),
    ...(authMode === "password" && !isCurrentUser ? (["password"] as const) : []),
    ...(authMode === "password" && !isCurrentUser && user.status === "invited" ? (["invitation"] as const) : []),
    ...(authMode === "password" && !isCurrentUser ? (["mfa"] as const) : []),
    ...(isCurrentUser ? [] : (["logout", "delete"] as const)),
  ];

  function openOperation(operation: Operation) {
    setOpen(operation);
    setReissued(null);
    setFailure(null);
    setPassword("");
    setConfirmation("");
  }

  async function run(operation: Operation, call: () => Promise<UserActionResult>) {
    setSending(true);
    setFailure(null);
    onNotice(null);
    const result = await call();
    switch (result.kind) {
      case "ok":
        // The screen is for admins only and the signed-in user is loaded once, so start again from the top.
        if (operation === "role" && isCurrentUser && newRole === "member") {
          location.assign("/");
          return;
        }
        setSending(false);
        setOpen(null);
        onNotice(SUCCESS_MESSAGES[operation]?.(userLabel(user)) ?? null);
        onReload();
        return;
      case "notFound":
        setSending(false);
        setOpen(null);
        onNotice(GONE_MESSAGE);
        onReload();
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  async function reissue() {
    setSending(true);
    setFailure(null);
    onNotice(null);
    const result = await reissueUserInvitation(client, user.id);
    switch (result.kind) {
      case "ok":
        setSending(false);
        setOpen(null);
        setReissued(result.invitation);
        return;
      case "notFound":
        setSending(false);
        setOpen(null);
        onNotice(GONE_MESSAGE);
        onReload();
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    switch (open) {
      case "role":
        void run("role", () => changeUserRole(client, user.id, newRole));
        return;
      case "password":
        void run("password", () => resetUserPassword(client, user.id, password));
        return;
      case "invitation":
        void reissue();
        return;
      case "mfa":
        void run("mfa", () => resetUserMfa(client, user.id));
        return;
      case "logout":
        void run("logout", () => revokeUserSessions(client, user.id));
        return;
      case "delete":
        if (confirmation !== user.email) return;
        void run("delete", () => deleteUser(client, user.id));
        return;
      case null:
        return;
    }
  }

  const operationLabel = (operation: Operation) =>
    operation === "role" ? (newRole === "admin" ? "管理者にする" : "メンバーにする") : OPERATION_LABELS[operation];

  return (
    <li>
      <div className="user-head">
        <span className="user-name">
          {user.name ?? <span className="user-unnamed">名前未設定</span>}
          {isCurrentUser && "（自分）"}
        </span>
        <span className="user-role">{ROLE_LABELS[user.role]}</span>
        {user.status === "invited" && <span className="user-status">招待中</span>}
      </div>
      <div className="user-detail">
        <span>{user.email}</span>
        <time dateTime={new Date(user.created_at).toISOString()}>作成: {formatDateTime(user.created_at)}</time>
        {user.last_login_at === null ? (
          <span>最終ログイン: 未ログイン</span>
        ) : (
          <time dateTime={new Date(user.last_login_at).toISOString()}>
            最終ログイン: {formatDateTime(user.last_login_at)}
          </time>
        )}
      </div>
      <div className="actions">
        {operations.map((operation) => (
          <button
            key={operation}
            type="button"
            // Deleting cannot be undone: it is set apart from the other operations.
            className={operation === "delete" ? "button-danger-outline" : undefined}
            onClick={() => openOperation(operation)}
            disabled={sending}
          >
            {operationLabel(operation)}
          </button>
        ))}
      </div>
      {open !== null && (
        <form className="folder-form" aria-label={operationLabel(open)} onSubmit={onSubmit}>
          {open === "role" && (
            <p>
              {newRole === "admin"
                ? `${userLabel(user)} を管理者にします。`
                : `${userLabel(user)} をメンバーにします。最後の管理者は変更できません。`}
              {isCurrentUser && newRole === "member" && "自分をメンバーにするとこの画面は使えなくなります。"}
            </p>
          )}
          {open === "password" && (
            <>
              <label>
                新しいパスワード（12&nbsp;文字以上）
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={sending}
                />
              </label>
              <p>このユーザーはすべての端末でログアウトし、MCP&nbsp;の接続も切れます。</p>
            </>
          )}
          {open === "invitation" && (
            <p>{userLabel(user)} の招待リンクを再発行します。これまでのリンクは使えなくなります。</p>
          )}
          {open === "mfa" && (
            <>
              <p>
                {`${userLabel(user)} の多要素認証（パスキー・認証アプリ・復旧コード）をすべて削除します。`}
                このユーザーはすべての端末でログアウトし、MCP&nbsp;の接続も切れます。パスワードは変わりません。
              </p>
              <p>
                リセットした後は、パスワードだけで新しい認証方法を登録できます。本人であることを確かめてからリセットし、すぐにログインして登録するよう伝えてください。端末と一緒にパスワードも漏れたおそれがあるときは、パスワードも再設定してください。
              </p>
            </>
          )}
          {open === "logout" && (
            <p>このユーザーをすべての端末でログアウトさせます。MCP&nbsp;の接続も切れます。</p>
          )}
          {open === "delete" && (
            <>
              <p>{userLabel(user)} を削除します。登録されたサイトは残ります。元に戻せません。</p>
              {authMode === "oidc" && (
                <p>削除すると、この人はログインできなくなります。もう一度使えるようにするには、ユーザーを追加し直してください。</p>
              )}
              <label>
                確認のため、このユーザーのメールアドレスを入力してください
                <input
                  type="text"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  disabled={sending}
                />
              </label>
            </>
          )}
          <div className="folder-form-actions">
            <button
              type="submit"
              className={open === "delete" ? "button-danger" : undefined}
              disabled={sending || (open === "delete" && confirmation !== user.email)}
            >
              {SUBMIT_LABELS[open]}
            </button>
            <button type="button" onClick={() => setOpen(null)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
      {reissued !== null && <InvitationLink invitation={reissued} onClose={() => setReissued(null)} />}
    </li>
  );
}

function userLabel(user: User): string {
  return user.name === null ? user.email : `${user.name}（${user.email}）`;
}

const OPERATION_LABELS: Record<Exclude<Operation, "role">, string> = {
  password: "パスワードを再設定",
  invitation: "招待リンクを再発行",
  mfa: "多要素認証をリセット",
  logout: "ログアウトさせる",
  delete: "削除",
};

const SUBMIT_LABELS: Record<Operation, string> = {
  role: "変更",
  password: "再設定",
  invitation: "再発行",
  mfa: "リセット",
  logout: "ログアウトさせる",
  delete: "削除",
};

// The notice after an operation whose result does not show in the list.
const SUCCESS_MESSAGES: Partial<Record<Operation, (label: string) => string>> = {
  password: (label) => `${label} のパスワードを再設定しました`,
  mfa: (label) => `${label} の多要素認証をリセットしました`,
  logout: (label) => `${label} をログアウトさせました`,
  delete: (label) => `${label} を削除しました`,
};
