import React, { useState, useRef, useEffect, useCallback, Suspense } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { XR, createXRStore, useXRHitTest } from '@react-three/xr'
import { OrbitControls, Grid, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import './App.css'

const store = createXRStore({
  sessionOptions: {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'dom-overlay-handler', 'local-floor'],
  }
})

function Reticle({ onPlace }) {
  const ref = useRef()
  const [isHit, setIsHit] = useState(false)

  // Use 'viewer' reference space to cast ray from camera center
  useXRHitTest((results, getWorldMatrix) => {
    if (results.length > 0) {
      if (ref.current) {
        ref.current.visible = true
        // Update matrix directly
        getWorldMatrix(ref.current.matrix, results[0])
      }
      setIsHit(true)
    } else {
      if (ref.current) {
        ref.current.visible = false
      }
      setIsHit(false)
    }
  }, 'viewer')

  return (
    <group ref={ref} visible={false}>
      {/* Visual Ring */}
      <mesh rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.1, 0.15, 32]} />
        <meshStandardMaterial color="white" />
      </mesh>
      {/* Invisible Click Target */}
      <mesh 
        rotation-x={-Math.PI / 2} 
        onClick={(e) => {
          e.stopPropagation()
          if (isHit) {
            const position = new THREE.Vector3().setFromMatrixPosition(ref.current.matrix)
            onPlace(position)
          }
        }}
      >
        <circleGeometry args={[0.15, 32]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  )
}

// 默认模型URL（可以使用任何GLTF/GLB模型）
// 这里使用Three.js示例中的鸭子模型，你也可以替换为任何GLTF/GLB模型的URL
const DEFAULT_MODEL_URL = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/models/gltf/Duck/glTF-Binary/Duck.glb'

// 加载3D模型组件
function LoadedModel({ url, scale = 1 }) {
  const { scene } = useGLTF(url)
  
  // 克隆场景以避免共享状态
  const clonedScene = scene.clone()
  
  // 调整模型大小
  const box = new THREE.Box3().setFromObject(clonedScene)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const targetSize = 0.5 // 目标大小（米）
  const modelScale = (targetSize / maxDim) * scale
  
  return <primitive object={clonedScene} scale={modelScale} />
}

// 锚定对象组件 - 对象会保持在世界空间中的固定位置
function AnchoredModel({ type, worldPosition, cameraPose, modelUrl }) {
  const groupRef = useRef()
  const { camera } = useThree()
  
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
    const localPos = worldPos.clone()
    localPos.sub(new THREE.Vector3(
      cameraPose.position[0],
      cameraPose.position[1],
      cameraPose.position[2]
    ))
    localPos.applyQuaternion(quaternion.invert())
    
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
          <LoadedModel url={modelUrl} scale={1} />
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

function Model({ type, position, anchored, cameraPose, modelUrl }) {
  // 如果锚定，使用AnchoredModel
  if (anchored && cameraPose) {
    return <AnchoredModel type={type} worldPosition={position} cameraPose={cameraPose} modelUrl={modelUrl} />
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
          <LoadedModel url={modelUrl} scale={1} />
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
      let isVRSupported = false
      
      try {
        isARSupported = await navigator.xr.isSessionSupported('immersive-ar')
        isVRSupported = await navigator.xr.isSessionSupported('immersive-vr')
      } catch (error) {
        console.error('检查WebXR支持时出错:', error)
        setArStatus('❌ 无法检查WebXR支持，可能浏览器不支持WebXR API')
        return
      }
      
      console.log('AR支持:', isARSupported)
      console.log('VR支持:', isVRSupported)
      console.log('User Agent:', navigator.userAgent)
      console.log('平台:', navigator.platform)
      
      if (!isARSupported) {
        if (isVRSupported) {
          setArStatus('⚠️ 检测到VR模拟器！请关闭Chrome的WebXR模拟器：chrome://flags/#webxr-runtime 设置为"None"')
          // 仍然尝试，但会检查会话类型
        } else {
          // 桌面环境可能不支持immersive-ar，提供降级方案
          const isDesktop = !/Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
          if (isDesktop) {
            setArStatus('⚠️ 桌面环境可能不支持immersive-ar。将尝试使用摄像头流作为降级方案...')
            // 继续执行，尝试启动AR
          } else {
            setArStatus('❌ 设备不支持AR模式。请：1) 使用Chrome/Edge 2) 访问 chrome://flags/#webxr-runtime 启用AR支持')
            return
          }
        }
      } else {
        setArStatus('✓ AR模式支持已确认')
      }

      // 确保有选中的摄像头
      if (!selectedCamera && cameras.length > 0) {
        setSelectedCamera(cameras[0].deviceId)
      }

      // 请求摄像头权限并验证摄像头可用
      if (selectedCamera) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
              deviceId: selectedCamera ? { exact: selectedCamera } : undefined,
              width: { ideal: 1920 },
              height: { ideal: 1080 }
            } 
          })
          // 验证流是否有效
          const videoTrack = stream.getVideoTracks()[0]
          if (videoTrack) {
            console.log('使用摄像头:', videoTrack.label || selectedCamera)
            console.log('摄像头设置:', videoTrack.getSettings())
          }
          stream.getTracks().forEach(track => track.stop())
        } catch (error) {
          console.error('摄像头访问失败:', error)
          setArStatus(`无法访问摄像头: ${error.message}`)
          return
        }
      } else {
        setArStatus('请先选择摄像头')
        return
      }

      // 进入AR模式 - 明确指定使用immersive-ar
      setArStatus('正在初始化AR会话...')
      
      try {
        // 直接使用WebXR API确保使用AR模式
        // 注意：不包含 entityTypes，因为某些polyfill不支持
        const sessionInit = {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay', 'dom-overlay-handler', 'local-floor'],
        }
        
        console.log('尝试启动AR会话，配置:', sessionInit)
        
        // 使用enterAR并传入配置
        await store.enterAR(sessionInit)
        
        // 验证会话类型
        const session = store.getState().session
        if (session) {
          console.log('XR会话类型:', session.mode)
          console.log('XR会话特性:', session.enabledFeatures)
          console.log('XR会话输入源:', session.inputSources)
          
          // 处理会话类型为 undefined 的情况
          if (!session.mode || session.mode === undefined) {
            const errorMsg = '会话类型是 undefined，可能是环境不支持AR或polyfill问题'
            console.log('检测到会话类型为undefined，将启用降级模式')
            setArStatus('⚠️ WebXR AR不可用，正在启用降级模式（摄像头流 + 手动控制）...')
            setErrorDetails(`信息: ${errorMsg}\n会话对象: ${JSON.stringify({
              mode: session.mode,
              enabledFeatures: session.enabledFeatures,
              inputSources: session.inputSources?.length || 0
            }, null, 2)}`)
            
            // 关闭会话并启用降级模式
            try {
              if (session && typeof session.end === 'function') {
                await session.end()
              }
            } catch (e) {
              console.warn('关闭会话时出错（可忽略）:', e)
            }
            
            // 启用降级模式
            try {
              await startFallbackMode()
              console.log('降级模式已成功启动')
            } catch (fallbackError) {
              console.error('启用降级模式失败:', fallbackError)
              setArStatus(`降级模式启动失败: ${fallbackError.message}`)
            }
            return
          }
          
          if (session.mode !== 'immersive-ar') {
            console.warn('警告: 会话类型不是immersive-ar，而是:', session.mode)
            setArStatus(`警告: 当前模式是 ${session.mode}，不是AR模式`)
            
            // 如果是VR模式，提示用户并关闭会话
            if (session.mode === 'immersive-vr') {
              setArStatus('❌ 错误: 进入了VR模拟器模式！将启用降级模式。要使用真实AR，请：1) 访问 chrome://flags/#webxr-runtime 2) 设置为"None"禁用模拟器 3) 刷新页面重试')
              
              // 关闭会话
              try {
                if (session.end) {
                  await session.end()
                }
              } catch (e) {
                console.warn('关闭会话时出错:', e)
              }
              
              // 启用降级模式
              await startFallbackMode()
              return
            }
          } else {
            setIsARSession(true)
            setArStatus('AR模式已启动 ✓ (immersive-ar)')
            // 启动AR后自动隐藏UI，保持场景干净
            setShowUI(false)
          }
          
          // 监听AR会话结束
          session.addEventListener('end', () => {
            setIsARSession(false)
            setArStatus('AR会话已结束')
          })
        } else {
          setArStatus('AR会话创建失败: 会话对象为空')
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
      // 启动AR后自动隐藏UI，保持场景干净
      setShowUI(false)

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

  const handlePlace = (position) => {
    setObjects(prev => [
      ...prev, 
      { 
        id: Date.now(), 
        type: objectType, 
        position: Array.isArray(position) ? position : [position.x, position.y, position.z],
        anchored: useFallbackMode, // 降级模式下使用锚定
        modelUrl: objectType === 'model' ? modelUrl : null
      }
    ])
  }

  // 设置锚定位置
  const handleAnchorSet = useCallback((worldPosition) => {
    const pos = Array.isArray(worldPosition) ? worldPosition : [worldPosition.x, worldPosition.y, worldPosition.z]
    setAnchorPosition(pos)
    console.log('锚定位置已设置:', pos)
  }, [])

  // 更新摄像头位姿
  const handlePoseUpdate = useCallback((pose) => {
    // 将设备方向转换为相机位姿
    // 这里使用简化的模型：假设设备就是摄像头
    cameraPoseRef.current = {
      position: [0, 0, 0], // 相机位置（世界原点）
      rotation: [
        pose.beta || 0,  // X轴旋转（前后倾斜）
        pose.alpha || 0, // Y轴旋转（左右旋转）
        pose.gamma || 0  // Z轴旋转（左右倾斜）
      ]
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
          <button onClick={handleExitAR} className="ar-button exit">
            退出AR模式
          </button>
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

      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#000' }}>
        {/* 降级模式：显示摄像头视频流 */}
        {useFallbackMode && (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedData={() => {
              console.log('视频数据加载完成', {
                videoWidth: videoRef.current?.videoWidth,
                videoHeight: videoRef.current?.videoHeight,
                readyState: videoRef.current?.readyState
              })
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              zIndex: 0,
              transform: 'scaleX(-1)', // 镜像翻转，更自然
              backgroundColor: '#000',
              display: 'block',
              visibility: 'visible',
              opacity: 1
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
            // 确保Canvas背景完全透明
            gl.setClearColor(0x000000, 0)
            scene.background = null
          }}
          style={{ 
            position: useFallbackMode ? 'absolute' : 'relative',
            zIndex: useFallbackMode ? 1 : 0,
            background: 'transparent', // 始终透明
            width: '100%',
            height: '100%',
            pointerEvents: 'auto' // 确保可以接收点击事件
          }}
        >
          {/* 降级模式下的点击处理组件 */}
          {useFallbackMode && (
            <>
              <FallbackClickHandler onPlace={handlePlace} onAnchorSet={handleAnchorSet} />
              <DeviceOrientationTracker onPoseUpdate={handlePoseUpdate} />
            </>
          )}
          <XR store={store}>
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

            {/* 只在真实AR模式下使用Reticle */}
            {!useFallbackMode && <Reticle onPlace={handlePlace} />}
            
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
