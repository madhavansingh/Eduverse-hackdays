interface Window {
  google?: {
    accounts?: {
      id?: {
        initialize: (config: Record<string, unknown>) => void;
        prompt: (callback?: (notification: { isNotDisplayed: () => boolean; isSkipped: () => boolean }) => void) => void;
        renderButton: (element: HTMLElement, config: Record<string, unknown>) => void;
      };
      oauth2?: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          callback: (response: { access_token?: string; error?: string }) => void;
        }) => { requestAccessToken: () => void };
      };
    };
  };
  AppleID?: {
    auth: {
      init: (config: Record<string, unknown>) => void;
      signIn: () => Promise<{
        authorization: { id_token: string };
        user?: { name?: { firstName?: string; lastName?: string } };
      }>;
    };
  };
}
