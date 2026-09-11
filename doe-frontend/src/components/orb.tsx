{/* Used free public lottie animation by luke mcglynn to create the orb 
  Luke's animation was used as a base - I changed the colors and duplicated it to create an in-depth orb look
  link to original animation: https://lottiefiles.com/free-animation/image-playground-animation-YuLs3cvt1I
  */}

import Lottie, { LottieRefCurrentProps } from "lottie-react";
import dancingOrb from "./dancingOrb.json"; 
import { useState, useEffect, useRef } from "react";

interface OrbAnimation {
  isThinking: boolean;
}

export default function OrbAnimation({ isThinking }: OrbAnimation) {
  const lottieRef = useRef<LottieRefCurrentProps | null>(null);
  const [offset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);

  // Adjusts speed of orb rotation - goes faster when a user submits a question (thinking) 
  useEffect(() => {
    const interval = setInterval(() => {
      let rotationSpeed = 1
      if (isThinking) rotationSpeed = 3
      setRotation(prev => (prev + rotationSpeed) % 360);
    }, 100); 
    return () => clearInterval(interval);
  }, [isThinking]);

  return (
    <div
      style={{
        margin: "0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: `translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg) scale(1.25)`,
        transition: "transform 0.05s linear",
      }}
    >
      <Lottie
        lottieRef={lottieRef}
        animationData={dancingOrb}
        loop
        autoplay
      />
    </div>
  );
}


;
