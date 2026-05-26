import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Suspense, useMemo, useRef, useLayoutEffect } from 'react';
import * as THREE from 'three';

// Helper to convert geographic lat/lon into 3D Cartesian coordinates
function getPosFromLatLon(lat: number, lon: number, radius: number) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = lon * (Math.PI / 180);

  // Standard sphere wrapping where lon=0 is at +Z and lon=90 is at +X
  const x = radius * Math.sin(phi) * Math.sin(theta);
  const z = radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);

  return new THREE.Vector3(x, y, z);
}

// Global points mapped to the landmasses
function EarthDots() {
  const texture = useLoader(THREE.TextureLoader, 'https://unpkg.com/three-globe/example/img/earth-water.png');
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const numPoints = 65000;
  const radius = 2.001; // Tightly hug the surface

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < numPoints; i++) {
      const y = 1 - (i / (numPoints - 1)) * 2;
      const rAtY = Math.sqrt(1 - y * y);
      const theta = phi * i;
      
      const x = Math.cos(theta) * rAtY;
      const z = Math.sin(theta) * rAtY;
      
      dummy.position.set(x * radius, y * radius, z * radius);
      
      // Orient the disk perfectly tangent to the sphere surface
      const normal = new THREE.Vector3(x, y, z).normalize();
      dummy.lookAt(dummy.position.clone().add(normal));
      dummy.updateMatrix();
      
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, []);

  const uniforms = useMemo(() => ({
    uMap: { value: texture },
  }), [texture]);

  const onBeforeCompile = (shader: any) => {
    shader.uniforms.uMap = uniforms.uMap;
    
    shader.vertexShader = `
      uniform sampler2D uMap;
      ${shader.vertexShader}
    `.replace(
      `#include <project_vertex>`,
      `
      // Get the instance position from the transformation matrix
      vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      vec3 instPosNorm = normalize(instPos);
      
      // Calculate UV for equirectangular projection mapping
      float u = 0.5 + atan(instPosNorm.x, instPosNorm.z) / (2.0 * 3.14159265);
      float v = 0.5 + asin(instPosNorm.y) / 3.14159265;
      
      vec4 texColor = texture2D(uMap, vec2(u, v));
      
      // The public texture has water as white. If water, collapse the vertex to hide it.
      if (texColor.r > 0.2) {
        transformed *= 0.0; 
      }

      #include <project_vertex>
      `
    );
  };

  return (
    <instancedMesh ref={meshRef} args={[null as any, null as any, numPoints]}>
      <circleGeometry args={[0.011, 6]} />
      <meshBasicMaterial 
        color="#71717a"
        onBeforeCompile={onBeforeCompile}
        transparent={true}
        opacity={0.8}
      />
    </instancedMesh>
  );
}

// Animated dashed line segment that travels along the curve
function FlowSegment({ curve, speed = 0.5, initialOffset = 0 }: { curve: THREE.Curve<THREE.Vector3>, speed?: number, initialOffset?: number }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  useFrame((_, delta) => {
    if (materialRef.current) {
      materialRef.current.uniforms.time.value -= delta * speed * 2.0;
    }
  });

  const uniforms = useMemo(() => ({
    time: { value: initialOffset },
    color: { value: new THREE.Color("#22d3ee") }
  }), [initialOffset]);

  return (
    <mesh>
      <tubeGeometry args={[curve, 44, 0.012, 8, false]} />
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={uniforms}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          uniform float time;
          uniform vec3 color;
          varying vec2 vUv;
          void main() {
            float head = fract(vUv.x * 2.0 + time);
            // Sharp front (1 down to 0 at 0.42 to 0.4), smooth tail (0.4 down to 0.0)
            float mask = smoothstep(0.0, 0.4, head) * (1.0 - smoothstep(0.4, 0.42, head));
            gl_FragColor = vec4(color, mask * 0.9);
          }
        `}
      />
    </mesh>
  );
}

// Bezier arc between two geographic locations
function Arc({ startLat, startLon, endLat, endLon, useRelays = false }: { startLat: number, startLon: number, endLat: number, endLon: number, useRelays?: boolean }) {
  const radius = 2.002; 
  const start = getPosFromLatLon(startLat, startLon, radius);
  const end = getPosFromLatLon(endLat, endLon, radius);

  const randomOffset = useMemo(() => Math.random(), []);

  const segments = useMemo(() => {
    const totalAngle = start.angleTo(end);
    
    let axis = start.clone().cross(end).normalize();
    if (axis.lengthSq() < 0.0001) {
      axis = start.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
      if (axis.lengthSq() < 0.0001) {
        axis = start.clone().cross(new THREE.Vector3(1, 0, 0)).normalize();
      }
    }

    // Break into segments if the arc uses relays
    const numSegments = useRelays ? 2 : 1;
    const segAngle = totalAngle / numSegments;

    const segs = [];
    for (let i = 0; i < numSegments; i++) {
      const pt1 = start.clone().applyAxisAngle(axis, i * segAngle);
      const pt2 = start.clone().applyAxisAngle(axis, (i + 1) * segAngle);

      const points = [];
      const numPoints = 20;

      for (let j = 0; j <= numPoints; j++) {
        const t = j / numPoints;
        const currentAngle = segAngle * t;
        const p = pt1.clone().applyAxisAngle(axis, currentAngle);
        
        // Parabolic arc height: 0 at ends, 1 in middle
        const h_t = 1 - Math.pow(2 * t - 1, 2);
        // Lowered altitude multiplier from 0.35 to 0.15 for tighter hugging
        const altitude = radius + segAngle * 0.15 * h_t; 
        
        p.normalize().multiplyScalar(altitude);
        points.push(p);
      }

      segs.push({
        curve: new THREE.CatmullRomCurve3(points),
        endPoint: pt2
      });
    }

    return segs;
  }, [start, end, useRelays]);

  return (
    <group>
      {/* Flight Path Arc Segments */}
      {segments.map((seg, i) => (
        <group key={`curve-${i}`}>
          <mesh>
            <tubeGeometry args={[seg.curve, 44, 0.008, 8, false]} />
            <meshBasicMaterial color="#a855f7" transparent opacity={0.6} />
          </mesh>
          <FlowSegment curve={seg.curve} speed={0.4} initialOffset={randomOffset} />
        </group>
      ))}
      
      {/* Start Node */}
      <mesh position={start}>
        <sphereGeometry args={[0.03, 16, 16]} />
        <meshBasicMaterial color="#3b82f6" />
      </mesh>
      
      {/* Relay and End Nodes */}
      {segments.map((seg, i) => (
        <mesh position={seg.endPoint} key={`node-${i}`}>
          <sphereGeometry args={i === segments.length - 1 ? [0.03, 16, 16] : [0.015, 16, 16]} />
          <meshBasicMaterial color={i === segments.length - 1 ? "#3b82f6" : "#93c5fd"} />
        </mesh>
      ))}
    </group>
  );
}

function SceneElements() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.05;
    }
  });

  // Shanghai Coordinates: 31.2304, 121.4737
  return (
    <group ref={groupRef} rotation={[0.2, 0, 0]}>
      {/* Base White Globe */}
      <mesh>
        <sphereGeometry args={[2, 64, 64]} />
        <meshStandardMaterial 
          color="#fdfdfe"
          emissive="#fdfdfe"
          emissiveIntensity={0.1}
          roughness={1} 
          metalness={0} 
        />
      </mesh>

      {/* Surface Data Points */}
      <EarthDots />

      {/* Network Connections to Shanghai */}
      <Arc startLat={40.7128} startLon={-74.0060} endLat={31.2304} endLon={121.4737} />
      <Arc startLat={-33.8688} startLon={151.2093} endLat={31.2304} endLon={121.4737} />
      <Arc startLat={25.2048}  startLon={55.2708} endLat={31.2304} endLon={121.4737} />
      <Arc startLat={37.7749}  startLon={-122.4194} endLat={31.2304} endLon={121.4737} />
      <Arc startLat={48.8566}  startLon={2.3522} endLat={31.2304} endLon={121.4737} />
      <Arc startLat={-33.9249} startLon={18.4241} endLat={31.2304} endLon={121.4737} />
    </group>
  );
}

export function EarthScene() {
  return (
    <div className="absolute inset-0 z-0 w-full h-full bg-gradient-to-b from-[#f8fafc] to-[#e2e8f0]">
      <Canvas camera={{ position: [0, 0, 6], fov: 45 }}>
        <fog attach="fog" args={['#f8fafc', 6, 18]} />
        <ambientLight intensity={3.5} />
        {/* Soft lighting for the pristine white globe aesthetic */}
        <directionalLight position={[0, 5, 10]} intensity={2.5} color="#ffffff" />
        <directionalLight position={[-10, -5, 5]} intensity={1.5} color="#f8fafc" />
        
        <Suspense fallback={null}>
          <SceneElements />
        </Suspense>

        <OrbitControls
          enableZoom={true}
          enablePan={false}
          autoRotate
          autoRotateSpeed={0.5}
          minDistance={3}
          maxDistance={10}
        />
      </Canvas>
    </div>
  );
}
