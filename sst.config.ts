const domainName = app.stage === "prod" ? "opavc.com" : `${app.stage}.opavc.com`;

const domain = {
  domainName: domainName,
  hostedZone: "opavc.com",
};

const apiDomain = `api.${app.stage === "prod" ? "opavc.com" : `${app.stage}.opavc.com`}`;
const webDomain = app.stage === "prod" ? "opavc.com" : `${app.stage}.opavc.com`; 