import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Line, Sphere } from '@react-three/drei';
import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BeakerIcon, CpuChipIcon, ChartBarIcon } from '@heroicons/react/24/outline';

interface FeatureCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
}

function TestMatrix() {
  const points = useMemo(() => {
    const gridSize = 4;
    const points = [];
    // Create grid points
    for (let x = -gridSize; x <= gridSize; x += 2) {
      for (let y = -gridSize; y <= gridSize; y += 2) {
        points.push(new THREE.Vector3(x, y, 0));
      }
    }
    return points;
  }, []);

  const connections = useMemo(() => {
    const lines = [];
    const points = [];
    // Create combinatorial test connections
    for (let i = 0; i < 15; i++) {
      const start = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 3
      );
      const end = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 3
      );
      points.push(start, end);
      lines.push([start, end]);
    }
    return { lines, points };
  }, []);

  const matrixRef = useRef<THREE.Group>(null);
  
  useFrame((state) => {
    if (matrixRef.current) {
      const time = state.clock.getElapsedTime();
      matrixRef.current.rotation.z = Math.sin(time * 0.2) * 0.1;
      matrixRef.current.rotation.y = time * 0.1;
    }
  });

  return (
    <group ref={matrixRef}>
      {/* Test points */}
      {points.map((point, i) => (
        <Sphere key={i} position={[point.x, point.y, point.z]} args={[0.15, 16, 16]}>
          <meshStandardMaterial
            color="#6366f1"
            emissive="#4834d4"
            emissiveIntensity={0.5}
            metalness={0.8}
            roughness={0.2}
          />
        </Sphere>
      ))}
      
      {/* Combinatorial connections */}
      {connections.lines.map((line, i) => (
        <Line
          key={i}
          points={line}
          color="#4834d4"
          lineWidth={1}
          transparent
          opacity={0.6}
        />
      ))}
      
      {/* Dynamic test cases */}
      {connections.points.map((point, i) => (
        <Sphere key={`dynamic-${i}`} position={[point.x, point.y, point.z]} args={[0.08, 8, 8]}>
          <meshStandardMaterial
            color="#22d3ee"
            emissive="#22d3ee"
            emissiveIntensity={0.5}
            metalness={1}
            roughness={0}
          />
        </Sphere>
      ))}
    </group>
  );
}

const Home = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-black text-white">
      <div className="container mx-auto px-6 py-8">
        <div className="flex flex-col items-center justify-center gap-6">
          <div className="flex items-center justify-center gap-8">
            <motion.img
              src="/images/doe-logo-final.png"
              alt="DOE Logo"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-20 h-20 md:w-28 md:h-28 lg:w-32 lg:h-32"
            />
            <motion.h1
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-6xl md:text-7xl lg:text-8xl font-bold text-center bg-clip-text text-transparent bg-gradient-to-r from-violet-500 via-purple-500 to-indigo-500">
              DOE
            </motion.h1>
          </div>

          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-lg md:text-xl lg:text-2xl text-center text-gray-300 max-w-4xl">
            Your intelligent companion for combinatorial testing and software quality assurance
          </motion.p>

          <div className="h-[350px] md:h-[400px] lg:h-[450px] w-full max-w-4xl rounded-lg overflow-hidden bg-gradient-to-b from-gray-800/50 to-gray-900/50 backdrop-blur-xl">
            <Canvas camera={{ position: [0, 0, 12] }}>
              <ambientLight intensity={0.4} />
              <pointLight position={[10, 10, 10]} intensity={0.8} />
              <pointLight position={[-10, -10, -10]} intensity={0.4} color="#4834d4" />
              <TestMatrix />
              <OrbitControls enableZoom={false} autoRotate autoRotateSpeed={0.5} />
            </Canvas>
          </div>

          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="mt-8">
            <Link
              to="/chat"
              className="px-8 py-4 bg-gradient-to-r from-violet-600 to-indigo-600 rounded-full text-xl font-semibold hover:from-violet-700 hover:to-indigo-700 transition-all duration-300 shadow-lg hover:shadow-xl">
              Start Exploring
            </Link>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16">
            <FeatureCard
              title="Advanced Testing"
              description="State-of-the-art combinatorial testing algorithms for comprehensive software quality assurance"
              icon={<BeakerIcon className="w-12 h-12 text-violet-400" />}
            />
            <FeatureCard
              title="AI-Powered Analysis"
              description="Intelligent analysis of test scenarios and results using cutting-edge machine learning"
              icon={<CpuChipIcon className="w-12 h-12 text-violet-400" />}
            />
            <FeatureCard
              title="Smart Insights"
              description="Data-driven recommendations and insights to optimize your testing strategy"
              icon={<ChartBarIcon className="w-12 h-12 text-violet-400" />}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

function FeatureCard({ title, description, icon }: FeatureCardProps) {
  return (
    <motion.div
      whileHover={{ y: -5 }}
      className="bg-white/5 backdrop-blur-lg rounded-xl p-8 border border-white/10 hover:border-violet-500/30 transition-all group">
      <div className="mb-4 transform transition-transform duration-300 group-hover:scale-110">
        {icon}
      </div>
      <h3 className="text-xl font-bold text-violet-400 mb-2">{title}</h3>
      <p className="text-gray-400">{description}</p>
    </motion.div>
  );
}

export default Home;