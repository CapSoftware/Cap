export const DashboardTemplate = ({
  title,
  description,
  button,
  children,
}: {
  title?: string;
  description?: string;
  button?: React.ReactNode;
  children?: React.ReactNode;
}) => {
  return (
    <div className="dashboard-page">
      <div className={`dashboard-header ${title && " has-title"}`}>
        <div>
          {title && <h1>{title}</h1>}
          {description && <p>{description}</p>}
        </div>
        {button && <div>{button}</div>}
      </div>
      {children && children}
    </div>
  );
};
