import { scryptSync, timingSafeEqual } from "node:crypto";
export interface LocalLogin { username: string; salt: string; verifier: string }
export function validLocalLogin(login: LocalLogin, username: string, password: string): boolean {
  if (password.length < 8 || password.length > 1024 || !/^[a-f0-9]{128}$/.test(login.verifier)) return false;
  return timingSafeEqual(scryptSync(password, login.salt, 64), Buffer.from(login.verifier,"hex")) && username === login.username;
}
