import React, { useState, useRef, useEffect, useCallback, Suspense } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { XR, createXRStore, useXRHitTest, useXR } from '@react-three/xr'
import { OrbitControls, Grid, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import './App.css'

// 使用React Three XR的useXRHitTest hook（更可靠）
function NativeWebXRHitTest({ onHitMatrixUpdate }) {
  // 使用useXRHitTest进行hit-test
  useXRHitTest((results, getWorldMatrix) => {
    if (results.length > 0) {
      const matrix = new THREE.Matrix4()
      getWorldMatrix(matrix, results[0])
      onHitMatrixUpdate(matrix)
    } else {
      onHitMatrixUpdate(null)
    }
  }, 'viewer')

  return null
}

const store = createXRStore({
  sessionOptions: {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'dom-overlay-handler', 'local-floor', 'anchors'],
  }
})

// 真正的AR十字准星 - 使用原生WebXR hit-test
function Reticle({ onPlace, hitMatrix }) {
  const ref = useRef()
  const [isHit, setIsHit] = useState(false)
  
  // 根据模型的targetSize自动计算十字星大小
  // 模型targetSize = 0.5（正常比例），十字星应该是模型的合理大小
  const MODEL_TARGET_SIZE = 0.5
  const RETICLE_SCALE = 0.25 // 十字星相对于模型的大小倍数（缩小）
  const innerRadius = MODEL_TARGET_SIZE * RETICLE_SCALE * 0.8 // 内圈半径
  const outerRadius = MODEL_TARGET_SIZE * RETICLE_SCALE * 1.2 // 外圈半径
  const centerRadius = MODEL_TARGET_SIZE * RETICLE_SCALE * 0.5 // 中心点半径
  const clickRadius = MODEL_TARGET_SIZE * RETICLE_SCALE * 1.5 // 点击区域半径

  useFrame(() => {
    if (!ref.current) return
    
    if (hitMatrix) {
      ref.current.visible = true
      // 直接使用hit-test矩阵，它已经包含了正确的位置和旋转
      ref.current.matrix.copy(hitMatrix)
      ref.current.matrixAutoUpdate = false
      setIsHit(true)
    } else {
      ref.current.visible = false
      setIsHit(false)
    }
  })


  return (
    <group ref={ref} visible={false}>
      {/* Visual Ring - 贴合地面的十字准星 */}
      {/* hit-test矩阵已经包含了正确的旋转，直接使用即可 */}
      <group>
        <mesh>
          <ringGeometry args={[innerRadius, outerRadius, 32]} />
          <meshStandardMaterial 
            color="white" 
            emissive={0xffffff}
            emissiveIntensity={0.5}
          />
        </mesh>
        {/* 中心点 - 几乎贴地 */}
        <mesh position={[0, 0.001, 0]}>
          <circleGeometry args={[centerRadius, 32]} />
          <meshStandardMaterial 
            color="white" 
            emissive={0xffffff}
            emissiveIntensity={1}
          />
        </mesh>
        {/* Invisible Click Target */}
        <mesh 
          onClick={(e) => {
            e.stopPropagation()
            if (isHit && ref.current) {
              const position = new THREE.Vector3().setFromMatrixPosition(ref.current.matrix)
              onPlace(position, hitMatrix)
            }
          }}
        >
          <circleGeometry args={[clickRadius, 32]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      </group>
    </group>
  )
}

// 默认模型URL（使用本地assets目录下的模型）
// 使用 ?url 后缀让Vite将文件作为URL导入
import modelGlb from './assets/model.glb?url'
const DEFAULT_MODEL_URL = modelGlb

// 加载3D模型组件
function LoadedModel({ url, scale = 1 }) {
  const { scene } = useGLTF(url)
  
  // 克隆场景以避免共享状态
  const clonedScene = scene.clone()
  
  // 调整模型大小
  const box = new THREE.Box3().setFromObject(clonedScene)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const targetSize = 0.5 // 目标大小（米）- 正常比例
  const modelScale = (targetSize / maxDim) * scale
  
  return <primitive object={clonedScene} scale={modelScale} />
}

// 真正的AR锚定对象组件 - 使用WebXR空间锚点
// 模型必须固定在真实世界中的固定位置，移动设备时模型保持不动
function ARAnchoredModel({ type, anchor, modelUrl, hitMatrix, scale = 1 }) {
  const groupRef = useRef()
  const { gl } = useThree()
  const fixedMatrixRef = useRef(null)
  
  // 初始化时保存固定矩阵（只在第一次设置）
  useEffect(() => {
    if (hitMatrix && !fixedMatrixRef.current) {
      fixedMatrixRef.current = hitMatrix.clone()
      console.log('✅ 保存模型固定位置矩阵')
    }
  }, [hitMatrix])
  
  useFrame((state, delta, frame) => {
    if (!groupRef.current) return
    
    // 优先使用WebXR锚点（最准确）
    if (anchor?.anchorSpace) {
      try {
        const xrFrame = frame?.xrFrame || gl.xr?.getFrame()
        if (xrFrame) {
          const referenceSpace = gl.xr?.getReferenceSpace()
          if (referenceSpace) {
            const pose = xrFrame.getPose(anchor.anchorSpace, referenceSpace)
            if (pose) {
              // 从WebXR锚点获取当前帧的位置（锚点会跟踪真实世界）
              const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix)
              groupRef.current.matrix.copy(matrix)
              groupRef.current.matrix.decompose(
                groupRef.current.position,
                groupRef.current.quaternion,
                groupRef.current.scale
              )
              groupRef.current.matrixAutoUpdate = false
              return
            }
          }
        }
      } catch (error) {
        // 如果锚点获取失败，使用固定矩阵
        console.warn('从锚点获取位置失败，使用固定矩阵:', error)
      }
    }
    
    // 使用保存的固定矩阵（模型固定在真实世界中）
    if (fixedMatrixRef.current) {
      // 需要将固定矩阵转换到当前参考空间
      // 在WebXR中，如果矩阵是在local空间中创建的，它会自动保持在真实世界中的位置
      const xrFrame = frame?.xrFrame || gl.xr?.getFrame()
      if (xrFrame) {
        try {
          const referenceSpace = gl.xr?.getReferenceSpace()
          if (referenceSpace) {
            // 固定矩阵已经是世界空间的，直接使用
            groupRef.current.matrix.copy(fixedMatrixRef.current)
            groupRef.current.matrix.decompose(
              groupRef.current.position,
              groupRef.current.quaternion,
              groupRef.current.scale
            )
            groupRef.current.matrixAutoUpdate = false
            return
          }
        } catch (error) {
          // 如果获取参考空间失败，直接使用固定矩阵
        }
      }
      
      // 降级：直接使用固定矩阵
      groupRef.current.matrix.copy(fixedMatrixRef.current)
      groupRef.current.matrix.decompose(
        groupRef.current.position,
        groupRef.current.quaternion,
        groupRef.current.scale
      )
      groupRef.current.matrixAutoUpdate = false
      return
    }
    
    // 如果锚点空间不可用，使用固定位置（从创建时的矩阵）
    if (anchor?.matrix) {
      const matrix = new THREE.Matrix4().fromArray(anchor.matrix)
      groupRef.current.matrix.copy(matrix)
      groupRef.current.matrix.decompose(
        groupRef.current.position,
        groupRef.current.quaternion,
        groupRef.current.scale
      )
      groupRef.current.matrixAutoUpdate = false
    }
  })
  
  return (
    <group ref={groupRef}>
      {type === 'model' && modelUrl ? (
        <Suspense fallback={
          <mesh>
            <boxGeometry args={[0.2, 0.2, 0.2]} />
            <meshStandardMaterial color="gray" />
          </mesh>
        }>
          <LoadedModel url={modelUrl} scale={scale} />
        </Suspense>
      ) : type === 'cube' ? (
        <mesh>
          <boxGeometry args={[0.2, 0.2, 0.2]} />
          <meshStandardMaterial color="orange" />
        </mesh>
      ) : (
        <mesh>
          <sphereGeometry args={[0.1, 32, 32]} />
          <meshStandardMaterial color="hotpink" />
        </mesh>
      )}
    </group>
  )
}

// 降级模式下的锚定对象组件 - 使用设备方向跟踪
function FallbackAnchoredModel({ type, worldPosition, cameraPose, modelUrl, scale = 1 }) {
  const groupRef = useRef()
  const { camera, gl } = useThree()
  
  useFrame(() => {
    if (!groupRef.current || !worldPosition || !cameraPose) return
    
    // 将世界坐标转换为相机空间坐标
    // 当相机旋转时，对象应该保持在"世界空间"中的固定位置
    const worldPos = new THREE.Vector3(worldPosition[0], worldPosition[1], worldPosition[2])
    
    // 创建相机旋转的逆变换
    const euler = new THREE.Euler(
      cameraPose.rotation[0],
      cameraPose.rotation[1],
      cameraPose.rotation[2],
      'YXZ'
    )
    const quaternion = new THREE.Quaternion().setFromEuler(euler)
    
    // 将世界坐标转换为相机本地坐标
    // 使用改进的变换算法
    const localPos = worldPos.clone()
    
    // 如果有四元数，使用四元数（更精确）
    if (cameraPose.quaternion) {
      localPos.sub(new THREE.Vector3(
        cameraPose.position[0],
        cameraPose.position[1],
        cameraPose.position[2]
      ))
      localPos.applyQuaternion(cameraPose.quaternion.clone().invert())
    } else {
      // 否则使用欧拉角
      localPos.sub(new THREE.Vector3(
        cameraPose.position[0],
        cameraPose.position[1],
        cameraPose.position[2]
      ))
      localPos.applyQuaternion(quaternion.invert())
    }
    
    groupRef.current.position.copy(localPos)
  })
  
  return (
    <group ref={groupRef}>
      {type === 'model' && modelUrl ? (
        <Suspense fallback={
          <mesh>
            <boxGeometry args={[0.2, 0.2, 0.2]} />
            <meshStandardMaterial color="gray" />
          </mesh>
        }>
          <LoadedModel url={modelUrl} scale={scale} />
        </Suspense>
      ) : type === 'cube' ? (
        <mesh>
          <boxGeometry args={[0.2, 0.2, 0.2]} />
          <meshStandardMaterial color="orange" />
        </mesh>
      ) : (
        <mesh>
          <sphereGeometry args={[0.1, 32, 32]} />
          <meshStandardMaterial color="hotpink" />
        </mesh>
      )}
    </group>
  )
}

function Model({ type, position, anchored, cameraPose, modelUrl, anchor, hitMatrix, scale = 1 }) {
  // 如果有WebXR锚点或hit-test矩阵，使用真正的AR锚定
  if (anchor || hitMatrix) {
    return <ARAnchoredModel type={type} anchor={anchor} modelUrl={modelUrl} hitMatrix={hitMatrix} scale={scale} />
  }
  
  // 如果降级模式锚定，使用设备方向跟踪
  if (anchored && cameraPose) {
    return <FallbackAnchoredModel type={type} worldPosition={position} cameraPose={cameraPose} modelUrl={modelUrl} scale={scale} />
  }
  
  // 否则使用固定位置
  const pos = Array.isArray(position) ? position : [position.x || 0, position.y || 0, position.z || 0]
  
  return (
    <group position={pos}>
      {type === 'model' && modelUrl ? (
        <Suspense fallback={
          <mesh>
            <boxGeometry args={[0.2, 0.2, 0.2]} />
            <meshStandardMaterial color="gray" />
          </mesh>
        }>
          <LoadedModel url={modelUrl} scale={scale} />
        </Suspense>
      ) : type === 'cube' ? (
        <mesh>
          <boxGeometry args={[0.2, 0.2, 0.2]} />
          <meshStandardMaterial color="orange" />
        </mesh>
      ) : (
        <mesh>
          <sphereGeometry args={[0.1, 32, 32]} />
          <meshStandardMaterial color="hotpink" />
        </mesh>
      )}
    </group>
  )
}

// 降级模式下的点击处理组件 - 支持锚定定位
function FallbackClickHandler({ onPlace, onAnchorSet }) {
  const { camera, gl, scene } = useThree()
  
  // 确保Canvas背景完全透明，以便显示视频背景
  useEffect(() => {
    // 设置清除色为完全透明
    gl.setClearColor(0x000000, 0)
    
    // 确保场景背景为null
    scene.background = null
    
    // 在每一帧都清除背景
    const originalRender = gl.render.bind(gl)
    gl.render = function(scene, camera) {
      this.setClearColor(0x000000, 0)
      originalRender(scene, camera)
    }
    
    return () => {
      gl.render = originalRender
    }
  }, [gl, scene])
  
  useEffect(() => {
    const handleClick = (event) => {
      const raycaster = new THREE.Raycaster()
      const mouse = new THREE.Vector2()
      
      const rect = gl.domElement.getBoundingClientRect()
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      
      raycaster.setFromCamera(mouse, camera)
      
      // 在距离相机3米的位置放置对象（世界坐标）
      const distance = 3
      const worldPosition = raycaster.ray.origin.clone().add(
        raycaster.ray.direction.clone().multiplyScalar(distance)
      )
      
      // 设置锚定位置（相对于初始相机位置）
      if (onAnchorSet) {
        onAnchorSet(worldPosition)
      }
      
      onPlace(worldPosition)
    }

    gl.domElement.addEventListener('click', handleClick)
    return () => {
      gl.domElement.removeEventListener('click', handleClick)
    }
  }, [camera, gl, onPlace, onAnchorSet])

  return null
}

// 设备方向跟踪组件 - 用于跟踪摄像头运动
function DeviceOrientationTracker({ onPoseUpdate }) {
  useEffect(() => {
    if (!window.DeviceOrientationEvent) {
      console.warn('设备不支持DeviceOrientationEvent')
      return
    }

    const handleOrientation = (event) => {
      if (event.alpha !== null && event.beta !== null && event.gamma !== null) {
        // alpha: 绕Z轴旋转（指南针方向，0-360度）
        // beta: 绕X轴旋转（前后倾斜，-180到180度）
        // gamma: 绕Y轴旋转（左右倾斜，-90到90度）
        
        const alpha = (event.alpha || 0) * Math.PI / 180 // 转换为弧度
        const beta = (event.beta || 0) * Math.PI / 180
        const gamma = (event.gamma || 0) * Math.PI / 180
        
        onPoseUpdate({
          alpha,
          beta,
          gamma,
          absolute: event.absolute || false
        })
      }
    }

    // 请求权限（iOS 13+需要）
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(response => {
          if (response === 'granted') {
            window.addEventListener('deviceorientation', handleOrientation)
          }
        })
        .catch(console.error)
    } else {
      window.addEventListener('deviceorientation', handleOrientation)
    }

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation)
    }
  }, [onPoseUpdate])

  return null
}

function App() {
  const [objects, setObjects] = useState([])
  const [objectType, setObjectType] = useState('model') // 默认使用模型
  const [modelUrl, setModelUrl] = useState(DEFAULT_MODEL_URL) // 默认模型URL
  const [isARSession, setIsARSession] = useState(false)
  const [arStatus, setArStatus] = useState('')
  const [cameras, setCameras] = useState([])
  const [selectedCamera, setSelectedCamera] = useState('')
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState(false)
  const [errorDetails, setErrorDetails] = useState(null)
  const [useFallbackMode, setUseFallbackMode] = useState(false)
  const [videoStream, setVideoStream] = useState(null)
  const videoRef = useRef(null)
  const [anchorPosition, setAnchorPosition] = useState(null) // 锚定位置（世界坐标）
  const cameraPoseRef = useRef({ position: [0, 0, 0], rotation: [0, 0, 0] }) // 摄像头位姿
  const [showUI, setShowUI] = useState(true) // 控制UI显示/隐藏，未启动AR时默认显示
  const anchorsRef = useRef(new Map()) // 存储WebXR锚点
  const [hitMatrix, setHitMatrix] = useState(null) // 存储当前hit-test矩阵（使用state触发重新渲染）
  const [modelScale, setModelScale] = useState(1) // 模型大小缩放比例

  // 获取可用摄像头列表（需要先请求权限才能获取设备标签）
  const refreshCameras = async () => {
    try {
      setArStatus('正在检测摄像头...')
      
      // 先请求权限以获取设备标签
      let permissionGranted = false
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        stream.getTracks().forEach(track => track.stop())
        permissionGranted = true
        setCameraPermissionGranted(true)
        setArStatus('摄像头权限已获取')
      } catch (error) {
        console.warn('摄像头权限请求:', error)
        setCameraPermissionGranted(false)
        setArStatus('需要摄像头权限才能显示设备名称')
      }
      
      // 获取设备列表
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter(device => device.kind === 'videoinput')
      
      if (videoDevices.length === 0) {
        setArStatus('未检测到摄像头设备')
        setCameras([])
        return
      }
      
      setCameras(videoDevices)
      
      // 如果没有选中的摄像头，选择第一个
      if (!selectedCamera || !videoDevices.find(c => c.deviceId === selectedCamera)) {
        setSelectedCamera(videoDevices[0].deviceId)
      }
      
      if (permissionGranted) {
        setArStatus(`检测到 ${videoDevices.length} 个摄像头`)
      } else {
        setArStatus(`检测到 ${videoDevices.length} 个摄像头（需要权限查看名称）`)
      }
    } catch (error) {
      console.error('获取摄像头列表失败:', error)
      setArStatus(`检测摄像头失败: ${error.message}`)
    }
  }

  useEffect(() => {
    refreshCameras()
  }, [])

  // 预加载默认模型
  useEffect(() => {
    try {
      useGLTF.preload(DEFAULT_MODEL_URL)
    } catch (e) {
      console.warn('模型预加载失败:', e)
    }
  }, [])

  // 当降级模式启用且视频流可用时，确保视频元素正确初始化
  useEffect(() => {
    if (useFallbackMode && videoStream && videoRef.current) {
      if (!videoRef.current.srcObject || videoRef.current.srcObject !== videoStream) {
        console.log('设置视频流到video元素')
        videoRef.current.srcObject = videoStream
          videoRef.current.play().then(() => {
            console.log('视频流在useEffect中播放成功')
            // 确保视频可见
            videoRef.current.style.display = 'block'
            videoRef.current.style.visibility = 'visible'
            videoRef.current.style.opacity = '1'
            console.log('视频元素在useEffect中设置完成:', {
              display: videoRef.current.style.display,
              visibility: videoRef.current.style.visibility,
              srcObject: !!videoRef.current.srcObject
            })
        }).catch((e) => {
          console.warn('视频播放错误:', e)
        })
      }
    }
  }, [useFallbackMode, videoStream])

  // 全局错误处理 - 捕获polyfill和其他未处理的错误
  useEffect(() => {
    const handleError = (event) => {
      const error = event.error || event
      const errorMessage = error?.message || String(error)
      
      // 过滤掉已知的polyfill警告
      if (errorMessage.includes('entityTypes') || 
          errorMessage.includes('_transformBasePoseMatrix') ||
          errorMessage.includes('DEPRECATED') ||
          errorMessage.includes('createWithEqualityFn') ||
          errorMessage.includes('useStoreWithEqualityFn') ||
          errorMessage.includes('zustand/traditional')) {
        // 这些是已知的兼容性问题，只记录到控制台（不显示给用户）
        // console.warn('已知的兼容性警告（可忽略）:', errorMessage)
        return
      }
      
      // 其他错误记录到状态
      if (errorMessage && !errorMessage.includes('Script error')) {
        console.error('捕获到错误:', error)
        setErrorDetails(prev => {
          const newError = `时间: ${new Date().toLocaleTimeString()}\n错误: ${errorMessage}\n${error?.stack || ''}`
          return prev ? prev + '\n\n' + newError : newError
        })
      }
    }

    // 捕获未处理的Promise拒绝
    const handleRejection = (event) => {
      const error = event.reason
      const errorMessage = error?.message || String(error)
      
      // 过滤已知的兼容性问题
      if (errorMessage.includes('entityTypes') || 
          errorMessage.includes('_transformBasePoseMatrix') ||
          errorMessage.includes('DEPRECATED') ||
          errorMessage.includes('createWithEqualityFn')) {
        // 这些是已知的兼容性问题，不显示给用户
        // console.warn('已知的Promise拒绝（可忽略）:', errorMessage)
        return
      }
      
      console.error('未处理的Promise拒绝:', error)
      setErrorDetails(prev => {
        const newError = `时间: ${new Date().toLocaleTimeString()}\nPromise拒绝: ${errorMessage}\n${error?.stack || ''}`
        return prev ? prev + '\n\n' + newError : newError
      })
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleRejection)

    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleRejection)
    }
  }, [])

  const handleEnterAR = async () => {
    try {
      setArStatus('正在启动AR模式...')
      
      // 检查WebXR支持
      if (!navigator.xr) {
        setArStatus('浏览器不支持WebXR，请使用Chrome或Edge浏览器')
        return
      }

      // 检查AR支持
      let isARSupported = false
      
      try {
        isARSupported = await navigator.xr.isSessionSupported('immersive-ar')
      } catch (error) {
        console.error('检查WebXR支持时出错:', error)
        setArStatus('❌ 无法检查WebXR支持，可能浏览器不支持WebXR API')
        return
      }
      
      if (!isARSupported) {
        setArStatus('❌ 设备不支持AR模式。请：1) 使用Android Chrome或iOS Safari 2) 访问 chrome://flags/#webxr-runtime 启用AR支持')
        return
      }

      setArStatus('✓ AR模式支持已确认，正在启动真正的WebXR AR...')

      // 使用React Three Fiber的XR系统启动AR会话（它会自动管理会话）
      try {
        const sessionInit = {
          requiredFeatures: ['hit-test', 'local'],
          optionalFeatures: ['dom-overlay', 'dom-overlay-handler', 'local-floor', 'anchors'],
        }
        
        console.log('正在启动AR会话，配置:', sessionInit)
        
        // 使用store.enterAR启动会话（让React Three Fiber管理）
        await store.enterAR(sessionInit)
        
        // 等待一下让会话完全初始化
        await new Promise(resolve => setTimeout(resolve, 100))
        
        // 验证会话类型
        const xrSession = store.getState().session
        if (xrSession) {
          console.log('✅ XR会话已创建')
          console.log('XR会话类型:', xrSession.mode)
          console.log('XR会话特性:', xrSession.enabledFeatures)
          console.log('XR会话输入源:', xrSession.inputSources)
          
          // 处理会话类型为 undefined 的情况（某些polyfill可能返回undefined）
          if (!xrSession.mode || xrSession.mode === undefined) {
            console.warn('⚠️ 会话类型是 undefined，可能是polyfill问题，但继续使用')
            // 不报错，继续使用（某些polyfill可能不设置mode）
            setIsARSession(true)
            setArStatus('✅ AR模式已启动（会话类型未定义，但继续运行）')
            // AR模式下保持UI可见，方便控制模型大小
            // setShowUI(false)
          } else if (xrSession.mode === 'immersive-ar') {
            // 正确的AR模式
            setIsARSession(true)
            setArStatus('✅ 真正的WebXR AR模式已启动！移动设备查看效果')
            // AR模式下保持UI可见，方便控制模型大小
            // setShowUI(false)
          } else if (xrSession.mode === 'immersive-vr') {
            // VR模式（可能是模拟器）
            console.warn('⚠️ 检测到VR模式，可能是模拟器')
            setArStatus('⚠️ 检测到VR模式（可能是模拟器）。如果这不是你想要的，请关闭WebXR模拟器')
            // 仍然继续，让用户决定
            setIsARSession(true)
            // AR模式下保持UI可见
            // setShowUI(false)
          } else {
            // 其他模式（如inline）
            console.log('会话模式:', xrSession.mode)
            setIsARSession(true)
            setArStatus(`✅ AR模式已启动（模式: ${xrSession.mode}）`)
            // AR模式下保持UI可见
            // setShowUI(false)
          }
          
          // 监听AR会话结束
          xrSession.addEventListener('end', () => {
            setIsARSession(false)
            setArStatus('AR会话已结束')
          })
        } else {
          setArStatus('⚠️ AR会话创建失败: 会话对象为空，尝试降级模式...')
          // 如果会话创建失败，尝试降级模式
          try {
            await startFallbackMode()
          } catch (fallbackError) {
            setArStatus(`AR启动失败: ${fallbackError.message}`)
          }
        }
      } catch (arError) {
        console.error('enterAR失败:', arError)
        
        // 记录详细错误信息
        const errorInfo = {
          message: arError.message,
          stack: arError.stack,
          name: arError.name
        }
        setErrorDetails(`enterAR错误:\n${JSON.stringify(errorInfo, null, 2)}`)
        
        // 检查是否是entityTypes相关错误
        if (arError.message && arError.message.includes('entityTypes')) {
          setArStatus('⚠️ 检测到entityTypes错误，这是polyfill兼容性问题，已自动处理')
        }
        
        // 如果immersive-ar失败，尝试使用inline模式
        setArStatus('immersive-ar失败，尝试inline模式...')
        
        try {
          // 对于桌面AR，可能需要使用inline模式
          const inlineSession = await navigator.xr.requestSession('inline', {
            requiredFeatures: ['hit-test'],
            optionalFeatures: ['dom-overlay'],
          })
          
          console.log('Inline会话创建成功:', inlineSession.mode)
          
          // 如果inline模式也返回undefined，直接使用降级模式
          if (!inlineSession.mode || inlineSession.mode === undefined) {
            console.warn('Inline会话模式也是undefined，使用降级模式')
            try {
              await inlineSession.end()
            } catch (e) {
              console.warn('关闭inline会话时出错:', e)
            }
            await startFallbackMode()
            return
          }
          
          setArStatus('使用inline AR模式（桌面摄像头）')
          setIsARSession(true)
          
          inlineSession.addEventListener('end', () => {
            setIsARSession(false)
            setArStatus('AR会话已结束')
          })
        } catch (inlineError) {
          console.error('inline模式也失败:', inlineError)
          
          // 最后的降级方案：使用摄像头流 + 手动控制视角
          setArStatus('⚠️ WebXR AR不可用，启用降级模式（摄像头流 + 手动控制）...')
          
          try {
            await startFallbackMode()
          } catch (fallbackError) {
            console.error('降级方案也失败:', fallbackError)
            setArStatus(`AR启动失败: ${arError.message}. 请确保: 1) 使用Chrome/Edge浏览器 2) 关闭WebXR模拟器 3) 使用HTTPS或localhost 4) 检查浏览器控制台获取详细错误`)
          }
        }
      }
    } catch (error) {
      console.error('启动AR失败:', error)
      setArStatus(`AR启动失败: ${error.message}`)
      setIsARSession(false)
    }
  }

  // 降级模式：使用摄像头流 + 手动控制
  const startFallbackMode = async () => {
    try {
      console.log('开始启动降级模式...')
      
      if (!selectedCamera && cameras.length > 0) {
        setSelectedCamera(cameras[0].deviceId)
      }
      
      if (!selectedCamera) {
        throw new Error('未选择摄像头，请先选择摄像头')
      }

      console.log('获取摄像头流，设备ID:', selectedCamera)
      
      // 获取摄像头流
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          deviceId: { exact: selectedCamera },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        } 
      })

      console.log('摄像头流获取成功')

      setVideoStream(stream)
      setUseFallbackMode(true)
      setIsARSession(true)
      setArStatus('✓ 降级模式已启动（摄像头流 + 手动控制视角）')
      // AR模式下保持UI可见，方便控制模型大小
      // setShowUI(false)

      // 使用 setTimeout 确保 videoRef 已经渲染
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().then(() => {
            console.log('视频流播放成功')
            console.log('视频元素状态:', {
              display: videoRef.current.style.display,
              visibility: videoRef.current.style.visibility,
              opacity: videoRef.current.style.opacity,
              srcObject: !!videoRef.current.srcObject,
              videoWidth: videoRef.current.videoWidth,
              videoHeight: videoRef.current.videoHeight
            })
            // 确保视频可见
            if (videoRef.current) {
              videoRef.current.style.display = 'block'
              videoRef.current.style.visibility = 'visible'
              videoRef.current.style.opacity = '1'
            }
          }).catch((e) => {
            console.warn('视频流播放警告:', e)
          })
        } else {
          console.warn('videoRef 尚未准备好，稍后重试')
        }
      }, 100)

    } catch (error) {
      console.error('启动降级模式失败:', error)
      setArStatus(`降级模式启动失败: ${error.message}. 请检查摄像头权限`)
      setIsARSession(false)
      setUseFallbackMode(false)
      throw error
    }
  }

  const handleExitAR = async () => {
    try {
      // 停止视频流
      if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop())
        setVideoStream(null)
      }
      
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }

      // 退出XR会话
      const session = store.getState().session
      if (session && typeof session.end === 'function') {
        try {
          await session.end()
        } catch (e) {
          console.warn('关闭XR会话时出错:', e)
        }
      }

      setUseFallbackMode(false)
      setIsARSession(false)
      setArStatus('已退出AR模式')
    } catch (error) {
      console.error('退出AR失败:', error)
      // 即使出错也重置状态
      setUseFallbackMode(false)
      setIsARSession(false)
      setArStatus('已退出AR模式')
    }
  }

  // 创建WebXR锚点
  const createXRAnchor = async (hitTestResult, referenceSpace) => {
    try {
      const session = store.getState().session
      if (!session) {
        console.warn('WebXR会话不可用')
        return null
      }

      // 尝试使用hit-test结果创建锚点（更精确）
      if (hitTestResult && session.requestAnchor) {
        try {
          const anchor = await session.requestAnchor(hitTestResult, referenceSpace)
          console.log('✅ WebXR锚点创建成功（基于hit-test）:', anchor)
          return anchor
        } catch (error) {
          console.warn('使用hit-test创建锚点失败，尝试使用位置:', error)
        }
      }

      // 降级方案：使用位置创建锚点
      if (session.requestAnchor) {
        const position = hitTestResult 
          ? new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(hitTestResult.getPose(referenceSpace).transform.matrix))
          : hitTestResult

        const matrix = new Float32Array(16)
        const mat = new THREE.Matrix4()
        if (position instanceof THREE.Vector3) {
          mat.makeTranslation(position.x, position.y, position.z)
        } else {
          mat.makeTranslation(position[0] || 0, position[1] || 0, position[2] || 0)
        }
        mat.toArray(matrix)

        const anchor = await session.requestAnchor(referenceSpace, { pose: { transform: { matrix } } })
        console.log('✅ WebXR锚点创建成功（基于位置）:', anchor)
        return anchor
      }

      return null
    } catch (error) {
      console.error('创建WebXR锚点失败:', error)
      return null
    }
  }

  const handlePlace = async (position, hitTestResult = null) => {
    const pos = Array.isArray(position) 
      ? new THREE.Vector3(position[0], position[1], position[2])
      : position instanceof THREE.Vector3 
        ? position 
        : new THREE.Vector3(position.x || 0, position.y || 0, position.z || 0)
    
    let anchor = null
    let fixedHitMatrix = null
    
    // 如果是在真正的AR模式下，尝试创建WebXR锚点或保存固定矩阵
    if (isARSession && !useFallbackMode) {
      const session = store.getState().session
      if (session) {
        try {
          // 优先尝试创建WebXR锚点（最准确，能跟踪真实世界）
          const referenceSpace = session.requestReferenceSpace('local-floor') 
            || session.requestReferenceSpace('local')
          
          if (referenceSpace) {
            // 如果有hit-test结果，使用它创建锚点
            if (hitTestResult && session.requestAnchor) {
              try {
                anchor = await session.requestAnchor(hitTestResult, referenceSpace)
                if (anchor) {
                  const anchorId = Date.now()
                  anchorsRef.current.set(anchorId, anchor)
                  console.log('✅ WebXR锚点已创建（基于hit-test）')
                }
              } catch (error) {
                console.warn('使用hit-test创建锚点失败，尝试使用位置:', error)
              }
            }
            
            // 如果锚点创建失败，尝试使用位置创建
            if (!anchor && session.requestAnchor && hitMatrix) {
              try {
                const matrix = hitMatrix
                const fixedPos = new THREE.Vector3().setFromMatrixPosition(matrix)
                
                // 创建变换矩阵
                const anchorMatrix = new Float32Array(16)
                matrix.toArray(anchorMatrix)
                
                anchor = await session.requestAnchor(referenceSpace, { 
                  pose: { transform: { matrix: anchorMatrix } } 
                })
                if (anchor) {
                  const anchorId = Date.now()
                  anchorsRef.current.set(anchorId, anchor)
                }
              } catch (error) {
                // 忽略错误
              }
            }
          }
          
          // 如果锚点创建失败，使用固定矩阵（降级方案）
          if (!anchor && hitMatrix) {
            fixedHitMatrix = hitMatrix.clone()
          }
        } catch (error) {
          // 降级：使用当前hit-test矩阵
          if (hitMatrix) {
            fixedHitMatrix = hitMatrix.clone()
          }
        }
      }
    }
    
    setObjects(prev => [
      ...prev, 
      { 
        id: Date.now(),
        type: objectType, 
        position: [pos.x, pos.y, pos.z],
        anchored: useFallbackMode || !!anchor || !!fixedHitMatrix,
        anchor: anchor,
        hitMatrix: fixedHitMatrix,
        modelUrl: objectType === 'model' ? modelUrl : null,
        scale: modelScale // 保存当前模型大小
      }
    ])
  }

  // 设置锚定位置
  const handleAnchorSet = useCallback((worldPosition) => {
    const pos = Array.isArray(worldPosition) ? worldPosition : [worldPosition.x, worldPosition.y, worldPosition.z]
    setAnchorPosition(pos)
    console.log('锚定位置已设置:', pos)
  }, [])

  // 更新摄像头位姿 - 改进的跟踪算法
  const handlePoseUpdate = useCallback((pose) => {
    // 将设备方向转换为相机位姿
    // 使用更精确的欧拉角转换
    const alpha = (pose.alpha || 0) * Math.PI / 180 // 绕Z轴（指南针方向）
    const beta = (pose.beta || 0) * Math.PI / 180   // 绕X轴（前后倾斜）
    const gamma = (pose.gamma || 0) * Math.PI / 180 // 绕Y轴（左右倾斜）
    
    // 转换为Three.js的坐标系（Y-up, Z-forward）
    // 注意：DeviceOrientation使用不同的坐标系
    cameraPoseRef.current = {
      position: [0, 0, 0], // 相机位置（世界原点）
      rotation: [
        beta,   // X轴旋转（俯仰角）
        alpha,  // Y轴旋转（偏航角）
        -gamma  // Z轴旋转（翻滚角，取反以匹配Three.js坐标系）
      ],
      quaternion: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(beta, alpha, -gamma, 'YXZ')
      )
    }
  }, [])

  const clearScene = () => {
    setObjects([])
  }

  return (
    <div className="container">
      {/* UI切换按钮 - 始终显示在右上角 */}
      <button
        onClick={() => setShowUI(!showUI)}
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          zIndex: 1000,
          padding: '0.5em 1em',
          borderRadius: '8px',
          border: '1px solid #646cff',
          background: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          cursor: 'pointer',
          fontSize: '0.9em',
          transition: 'opacity 0.3s'
        }}
        title={showUI ? '隐藏控制面板' : '显示控制面板'}
      >
        {showUI ? '隐藏UI' : '⚙️'}
      </button>

      {/* 控制面板 - 根据showUI状态显示/隐藏 */}
      {showUI && (
      <div className="overlay">
        <div className="status">{arStatus || (isARSession ? 'AR模式运行中' : '准备就绪')}</div>
        
        {arStatus.includes('模拟器') || arStatus.includes('VR模式') || arStatus.includes('undefined') ? (
          <div className="warning-box">
            <strong>⚠️ WebXR AR模式问题</strong>
            <p>常见解决方案：</p>
            <ol style={{ textAlign: 'left', fontSize: '0.85em', margin: '5px 0' }}>
              <li>禁用WebXR模拟器: <code>chrome://flags/#webxr-runtime</code> → 设置为"None"</li>
              <li>启用AR支持: <code>chrome://flags/#webxr-ar-module</code> → 启用</li>
              <li>确保使用HTTPS或localhost</li>
              <li>检查浏览器控制台的详细错误信息</li>
            </ol>
            {errorDetails && (
              <details style={{ marginTop: '10px', fontSize: '0.8em' }}>
                <summary style={{ cursor: 'pointer', color: '#ffc107' }}>查看错误详情</summary>
                <pre style={{ 
                  background: 'rgba(0,0,0,0.3)', 
                  padding: '5px', 
                  borderRadius: '3px',
                  overflow: 'auto',
                  maxHeight: '100px',
                  fontSize: '0.75em'
                }}>
                  {errorDetails}
                </pre>
              </details>
            )}
          </div>
        ) : null}
        
        <div style={{ display: 'flex', gap: '5px', alignItems: 'center', width: '100%' }}>
          {cameras.length > 0 ? (
            <select 
              value={selectedCamera} 
              onChange={(e) => setSelectedCamera(e.target.value)}
              className="camera-select"
              style={{ flex: 1 }}
            >
              {cameras.map((camera, index) => {
                let label = camera.label
                if (!label || label === '') {
                  // 如果没有标签，尝试生成一个描述性的名称
                  label = `摄像头 ${index + 1}`
                  // 如果是外接摄像头，通常deviceId会不同，可以根据这个判断
                  if (camera.deviceId.length > 20) {
                    label += ` (设备ID: ${camera.deviceId.slice(0, 12)}...)`
                  }
                }
                return (
                  <option key={camera.deviceId} value={camera.deviceId}>
                    {label}
                  </option>
                )
              })}
            </select>
          ) : (
            <div style={{ color: '#fff', padding: '5px' }}>未检测到摄像头</div>
          )}
          <button 
            onClick={refreshCameras} 
            className="refresh-button"
            title="刷新摄像头列表"
          >
            🔄
          </button>
        </div>
        
        {!isARSession ? (
          <button onClick={handleEnterAR} className="ar-button">
            启动AR模式
          </button>
        ) : (
          <>
            <button onClick={handleExitAR} className="ar-button exit">
              退出AR模式
            </button>
            {!useFallbackMode && (
              <div style={{ 
                marginTop: '10px', 
                padding: '10px', 
                background: hitMatrix ? 'rgba(0, 255, 0, 0.2)' : 'rgba(255, 255, 0, 0.2)', 
                borderRadius: '5px',
                fontSize: '0.85em',
                textAlign: 'left'
              }}>
                {hitMatrix ? (
                  <>
                    <div style={{ marginBottom: '5px', fontWeight: 'bold', color: '#00ff00' }}>
                      ✅ 检测到平面！白色圆圈已显示
                    </div>
                    <div style={{ fontSize: '0.9em' }}>
                      <strong>点击屏幕</strong>在白色圆圈位置放置3D模型
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ marginBottom: '5px', fontWeight: 'bold', color: '#ffc107' }}>
                      🔍 正在扫描环境...
                    </div>
                    <div style={{ fontSize: '0.9em' }}>
                      • 将手机摄像头<strong>对准地面或桌面</strong><br/>
                      • 缓慢移动手机，让AR系统<strong>扫描环境</strong><br/>
                      • 确保<strong>光线充足</strong>，对准<strong>有纹理的表面</strong><br/>
                      • 等待<strong>白色圆圈（十字准星）</strong>出现
                    </div>
                  </>
                )}
              </div>
            )}
            
            {/* AR模式下的模型大小控制 */}
            {isARSession && (
              <div style={{ 
                marginTop: '10px', 
                padding: '10px', 
                background: 'rgba(100, 100, 255, 0.2)', 
                borderRadius: '5px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
              }}>
                <div style={{ fontSize: '0.85em', fontWeight: 'bold', color: '#fff' }}>
                  📏 模型大小控制
                </div>
                <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                  <button
                    onClick={() => setModelScale(prev => Math.max(0.1, prev - 0.1))}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '5px',
                      border: '1px solid #646cff',
                      background: '#1a1a1a',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '0.9em'
                    }}
                    title="缩小模型"
                  >
                    ➖ 缩小
                  </button>
                  <div style={{ 
                    minWidth: '60px', 
                    textAlign: 'center', 
                    color: '#fff',
                    fontSize: '0.9em',
                    fontWeight: 'bold'
                  }}>
                    {(modelScale * 100).toFixed(0)}%
                  </div>
                  <button
                    onClick={() => setModelScale(prev => Math.min(5, prev + 0.1))}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '5px',
                      border: '1px solid #646cff',
                      background: '#1a1a1a',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '0.9em'
                    }}
                    title="放大模型"
                  >
                    ➕ 放大
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '5px' }}>
                  <button
                    onClick={() => setModelScale(0.5)}
                    style={{
                      flex: 1,
                      padding: '6px',
                      borderRadius: '5px',
                      border: '1px solid #646cff',
                      background: '#1a1a1a',
                      color: '#aaa',
                      cursor: 'pointer',
                      fontSize: '0.75em'
                    }}
                  >
                    50%
                  </button>
                  <button
                    onClick={() => setModelScale(1)}
                    style={{
                      flex: 1,
                      padding: '6px',
                      borderRadius: '5px',
                      border: '1px solid #646cff',
                      background: '#1a1a1a',
                      color: '#aaa',
                      cursor: 'pointer',
                      fontSize: '0.75em'
                    }}
                  >
                    100%
                  </button>
                  <button
                    onClick={() => setModelScale(2)}
                    style={{
                      flex: 1,
                      padding: '6px',
                      borderRadius: '5px',
                      border: '1px solid #646cff',
                      background: '#1a1a1a',
                      color: '#aaa',
                      cursor: 'pointer',
                      fontSize: '0.75em'
                    }}
                  >
                    200%
                  </button>
                </div>
                <div style={{ fontSize: '0.75em', color: '#aaa', textAlign: 'center' }}>
                  新放置的模型将使用此大小
                </div>
              </div>
            )}
          </>
        )}
        
        <div className="controls">
          <button 
            className={objectType === 'model' ? 'active' : ''} 
            onClick={() => setObjectType('model')}
          >
            3D模型
          </button>
          <button 
            className={objectType === 'cube' ? 'active' : ''} 
            onClick={() => setObjectType('cube')}
          >
            Cube
          </button>
          <button 
            className={objectType === 'sphere' ? 'active' : ''} 
            onClick={() => setObjectType('sphere')}
          >
            Sphere
          </button>
        </div>
        
        {objectType === 'model' && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <input
              type="text"
              value={modelUrl}
              onChange={(e) => setModelUrl(e.target.value)}
              placeholder="输入GLTF/GLB模型URL"
              style={{
                padding: '0.5em',
                borderRadius: '5px',
                border: '1px solid #646cff',
                background: '#1a1a1a',
                color: 'white',
                fontSize: '0.85em',
                width: '100%'
              }}
            />
            <div style={{ fontSize: '0.75em', color: '#aaa', textAlign: 'center' }}>
              支持 .gltf 或 .glb 格式
            </div>
          </div>
        )}
        <button onClick={clearScene}>Clear Scene</button>
        
        {errorDetails && (
          <button 
            onClick={() => setErrorDetails(null)} 
            style={{ fontSize: '0.8em', padding: '0.4em 0.8em' }}
            title="清除错误详情"
          >
            清除错误日志
          </button>
        )}
      </div>
      )}

      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', backgroundColor: useFallbackMode ? 'transparent' : '#000' }}>
        {/* 降级模式：显示摄像头视频流 - 必须在最底层 */}
        {useFallbackMode && (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedData={() => {
              console.log('✅ 视频数据加载完成', {
                videoWidth: videoRef.current?.videoWidth,
                videoHeight: videoRef.current?.videoHeight,
                readyState: videoRef.current?.readyState,
                visible: videoRef.current?.offsetParent !== null,
                zIndex: window.getComputedStyle(videoRef.current).zIndex
              })
            }}
            onPlay={() => {
              console.log('✅ 视频开始播放')
            }}
            onError={(e) => {
              console.error('❌ 视频播放错误:', e)
            }}
            style={{
              position: 'fixed', // 使用fixed确保在最底层
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              objectFit: 'cover',
              zIndex: -1, // 使用负数确保在所有元素之下
              transform: 'scaleX(-1)', // 镜像翻转，更自然
              backgroundColor: '#000',
              display: 'block !important',
              visibility: 'visible !important',
              opacity: '1 !important',
              pointerEvents: 'none' // 让点击事件穿透
            }}
          />
        )}

        <Canvas
          camera={{ position: [0, 1.6, 3], fov: 50 }}
          gl={{ 
            preserveDrawingBuffer: true,
            alpha: true, // 完全透明，以便在降级模式下显示视频背景
            antialias: true,
            powerPreference: "high-performance"
          }}
          onCreated={({ gl, scene }) => {
            // AR模式：背景必须是透明的，以便显示真实世界
            gl.setClearColor(0x000000, 0)
            scene.background = null
            
            console.log('✅ Canvas创建完成，背景设置为透明', {
              clearColor: gl.getClearColor(new THREE.Color()),
              clearAlpha: gl.getClearAlpha(),
              background: scene.background
            })
          }}
          style={{ 
            position: useFallbackMode ? 'fixed' : 'relative',
            top: useFallbackMode ? 0 : 'auto',
            left: useFallbackMode ? 0 : 'auto',
            width: '100%',
            height: '100%',
            zIndex: useFallbackMode ? 0 : 0, // 在视频之上（视频是-1）
            background: 'transparent',
            backgroundColor: 'transparent',
            pointerEvents: 'auto' // 确保可以接收点击事件
          }}
          className={useFallbackMode ? 'fallback-canvas' : ''}
        >
          {/* 降级模式下的点击处理组件 */}
          {useFallbackMode && (
            <>
              <FallbackClickHandler onPlace={handlePlace} onAnchorSet={handleAnchorSet} />
              <DeviceOrientationTracker onPoseUpdate={handlePoseUpdate} />
            </>
          )}
          <XR store={store}>
            {/* 原生WebXR hit-test处理组件 - 必须在XR内部，始终渲染 */}
            {!useFallbackMode && (
              <NativeWebXRHitTest 
                onHitMatrixUpdate={setHitMatrix}
              />
            )}
            
            <ambientLight intensity={0.5} />
            <pointLight position={[10, 10, 10]} />
            <directionalLight position={[0, 5, 5]} intensity={0.5} />
          
            {/* 降级模式下：如果使用锚定模式，禁用OrbitControls；否则启用 */}
            {!useFallbackMode && !isARSession && <OrbitControls makeDefault enableDamping dampingFactor={0.05} />}
            {useFallbackMode && anchorPosition && (
              <OrbitControls 
                makeDefault 
                enableDamping 
                dampingFactor={0.05}
                enabled={false} // 禁用手动控制，使用设备方向
              />
            )}
            {useFallbackMode && !anchorPosition && (
              <OrbitControls makeDefault enableDamping dampingFactor={0.05} />
            )}
            {/* 降级模式下不显示Grid，因为会覆盖视频背景 */}
            {!isARSession && !useFallbackMode && <Grid args={[10, 10]} cellColor="gray" sectionColor="white" fadeDistance={10} />}
            
            {/* 测试对象：降级模式下在场景中心放置一个默认模型 */}
            {useFallbackMode && objects.length === 0 && (
              <Suspense fallback={
                <mesh position={[0, 0, -3]}>
                  <boxGeometry args={[0.3, 0.3, 0.3]} />
                  <meshStandardMaterial color="gray" />
                </mesh>
              }>
                <group position={[0, 0, -3]}>
                  <LoadedModel url={DEFAULT_MODEL_URL} scale={1} />
                </group>
              </Suspense>
            )}
            
            {/* AR模式下：显示提示信息 */}
            {isARSession && !useFallbackMode && !hitMatrix && (
              <mesh position={[0, 0.5, -1]}>
                <planeGeometry args={[1, 0.3]} />
                <meshBasicMaterial color="yellow" transparent opacity={0.8} side={THREE.DoubleSide} />
              </mesh>
            )}

            {/* 只在真实AR模式下使用Reticle - 必须检测到平面才显示 */}
            {!useFallbackMode && isARSession && (
              <Reticle onPlace={handlePlace} hitMatrix={hitMatrix} />
            )}
            
            {/* 降级模式下的十字准星 */}
            {useFallbackMode && (
              <mesh position={[0, 0, -2]}>
                <ringGeometry args={[0.05, 0.08, 32]} />
                <meshBasicMaterial color="white" />
              </mesh>
            )}
          
            {/* 显示所有用户放置的对象 */}
            {objects.map(obj => (
              <Model 
                key={obj.id} 
                type={obj.type} 
                position={obj.position} 
                anchored={obj.anchored}
                cameraPose={cameraPoseRef.current}
                modelUrl={obj.modelUrl || modelUrl}
                anchor={obj.anchor} // WebXR锚点
                hitMatrix={obj.hitMatrix} // 原生hit-test矩阵
                scale={obj.scale || 1} // 模型大小
              />
            ))}
            
            {/* 降级模式下添加一个参考平面，帮助定位 */}
            {useFallbackMode && (
              <mesh position={[0, 0, -3]} rotation-x={-Math.PI / 2}>
                <planeGeometry args={[5, 5]} />
                <meshBasicMaterial color="white" transparent opacity={0.1} side={THREE.DoubleSide} />
              </mesh>
            )}
          </XR>
        </Canvas>

        {/* 降级模式提示 - 已移除，不再显示 */}
      </div>
    </div>
  )
}

export default App
