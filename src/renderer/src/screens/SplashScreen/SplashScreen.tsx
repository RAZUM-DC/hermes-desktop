import { useEffect } from "react";
import splashBg from "../../assets/hermesbg.webp";
import splashLogo from "../../assets/hermes-one.svg";

interface SplashScreenProps {
  onFinished: () => void;
}

function SplashScreen({ onFinished }: SplashScreenProps): React.JSX.Element {
  useEffect(() => {
    onFinished();
  }, [onFinished]);

  return (
    <div className="splash-screen">
      <img className="splash-bg" src={splashBg} alt="" />
      <img className="splash-logo" src={splashLogo} alt="Hermes One" />
    </div>
  );
}

export default SplashScreen;
