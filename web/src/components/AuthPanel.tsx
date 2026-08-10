import { useId, useState } from 'react';
import * as api from '../api';

interface Props {
  onAuthenticated: (user: api.User) => void;
}

export default function AuthPanel({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userId = useId();
  const passwordId = useId();
  const codeId = useId();

  const isSignup = mode === 'signup';
  const canSubmit =
    !busy && username.trim().length >= 2 && password.length >= 8 && (!isSignup || signupCode.trim());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user } = isSignup
        ? await api.signup(username.trim(), password, signupCode.trim())
        : await api.login(username.trim(), password);
      onAuthenticated(user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>{isSignup ? 'アカウント作成' : 'ログイン'}</h2>

      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}

      <div className="field">
        <label htmlFor={userId}>ユーザー名</label>
        <input
          id={userId}
          type="text"
          value={username}
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={passwordId}>パスワード（8文字以上）</label>
        <input
          id={passwordId}
          type="password"
          value={password}
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      {isSignup && (
        <div className="field">
          <label htmlFor={codeId}>招待コード</label>
          <input
            id={codeId}
            type="text"
            value={signupCode}
            onChange={(event) => setSignupCode(event.target.value)}
          />
        </div>
      )}

      <div className="actions">
        <button type="submit" className="primary block" disabled={!canSubmit}>
          {busy ? '処理中' : isSignup ? '作成' : 'ログイン'}
        </button>
      </div>

      <div className="actions center">
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(isSignup ? 'login' : 'signup');
            setError(null);
          }}
        >
          {isSignup ? 'ログインへ' : 'アカウントを作成'}
        </button>
      </div>
    </form>
  );
}
