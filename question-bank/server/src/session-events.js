import {ApiError} from './security.js';

/** Legacy clients receive a finite response instead of opening an idle stream. */
export function registerSessionEvents(app) {
  app.get('/v1/auth/session-events', async () => {
    // Existing clients back off for five minutes on 404. Updated clients never
    // subscribe: every protected business request checks the session itself.
    throw new ApiError(404,'SESSION_EVENTS_DISABLED','会话通知已停用，请更新应用；登录状态会在联网操作时校验');
  });
}
