export const generateDeeplink = (action: string, params?: Record<string, any>): string => {
  const url = new URL(`cap://action`);
  
  const actionObj: any = {};
  
  if (params) {
    actionObj[action] = params;
  } else {
    actionObj[action] = {};
  }
  
  url.searchParams.append("value", JSON.stringify(actionObj));
  return url.toString();
};
