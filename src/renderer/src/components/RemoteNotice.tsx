import { Signal } from "../assets/icons";

function RemoteNotice({ feature }: { feature: string }): React.JSX.Element {
  return (
    <div className="remote-notice">
      <Signal size={28} className="remote-notice-icon" />
      <p className="remote-notice-title">Подключено к серверу РАЗУМ</p>
      <p className="remote-notice-desc">
        {feature} недоступно в удалённом режиме. Эти данные живут на сервере и
        пока не доступны через API.
      </p>
    </div>
  );
}

export default RemoteNotice;
