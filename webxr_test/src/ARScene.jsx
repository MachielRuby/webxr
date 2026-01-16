import React, { useRef, useEffect, useState } from 'react'
import * as THREE from 'three'
import { useGLTF } from '@react-three/drei'

// 真正的WebXR AR场景组件 - 使用原生WebXR API
export function ARScene({ onPlace, modelUrl, objectType }) {
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const sceneRef = useRef(null)
  const cameraRef = useRef(null)
  const sessionRef = useRef(null)
  const referenceSpaceRef = useRef(null)
  const localSpaceRef = useRef(null)
  const hitTestSourceRef = useRef(null)
  const placedObjectsRef = useRef([])
  const currentHitMatrixRef = useRef(null)
  const reticleRef = useRef(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // 初始化Three.js场景
    const scene = new THREE.Scene()
    sceneRef.current = scene

    // 创建渲染器
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      alpha: true,
    })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.xr.enabled = true
    rendererRef.current = renderer

    // 创建相机
    const camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.01,
      20
    )
    cameraRef.current = camera

    // 添加光照
    const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1)
    light.position.set(0.5, 1, 0.25)
    scene.add(light)

    // 创建十字准星（reticle）
    const reticleGeometry = new THREE.RingGeometry(0.1, 0.15, 32)
    const reticleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const reticle = new THREE.Mesh(reticleGeometry, reticleMaterial)
    reticle.rotation.x = -Math.PI / 2
    reticle.visible = false
    scene.add(reticle)
    reticleRef.current = reticle

    // 清理函数
    return () => {
      if (sessionRef.current) {
        sessionRef.current.end()
      }
      renderer.dispose()
    }
  }, [])

  // 启动AR会话
  const startAR = async () => {
    if (!navigator.xr) {
      console.error('浏览器不支持WebXR')
      return false
    }

    const isSupported = await navigator.xr.isSessionSupported('immersive-ar')
    if (!isSupported) {
      console.error('设备不支持AR模式')
      return false
    }

    try {
      // 创建AR会话
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test', 'local-floor'],
        optionalFeatures: ['dom-overlay', 'anchors'],
        domOverlay: { root: document.getElementById('ar-ui-container') || document.body }
      })

      sessionRef.current = session

      // 设置参考空间
      const referenceSpace = await session.requestReferenceSpace('local-floor')
      const localSpace = await session.requestReferenceSpace('local-floor')
      referenceSpaceRef.current = referenceSpace
      localSpaceRef.current = localSpace

      // 绑定渲染器到XR
      rendererRef.current.xr.setReferenceSpaceType('local')
      rendererRef.current.xr.setSession(session)

      // 启动hit-test
      await startHitTest(session)

      // 开始渲染循环
      session.requestAnimationFrame(onXRFrame)

      // 监听退出事件
      session.addEventListener('end', () => {
        sessionRef.current = null
        referenceSpaceRef.current = null
        localSpaceRef.current = null
        hitTestSourceRef.current = null
        currentHitMatrixRef.current = null
        reticleRef.current.visible = false
      })

      return true
    } catch (error) {
      console.error('启动AR失败:', error)
      return false
    }
  }

  // 启动hit-test
  const startHitTest = async (session) => {
    const viewerSpace = await session.requestReferenceSpace('viewer')
    const hitTestSource = await session.requestHitTestSource({ space: viewerSpace })
    hitTestSourceRef.current = hitTestSource
  }

  // XR帧渲染循环 - 这是真正的AR渲染管道
  const onXRFrame = (t, frame) => {
    const session = sessionRef.current
    if (!session) return

    session.requestAnimationFrame(onXRFrame)

    const renderer = rendererRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    const referenceSpace = referenceSpaceRef.current
    const localSpace = localSpaceRef.current

    const pose = frame.getViewerPose(referenceSpace)
    if (!pose) return

    const glLayer = session.renderState.baseLayer
    renderer.setSize(glLayer.framebufferWidth, glLayer.framebufferHeight)
    renderer.clear()

    // 渲染每个视图
    for (const view of pose.views) {
      const viewport = renderer.xr.getViewport(view)
      renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height)

      // 更新相机投影矩阵
      camera.projectionMatrix.fromArray(view.projectionMatrix)
      
      // 更新相机视图矩阵
      const viewMatrix = new THREE.Matrix4().fromArray(view.transform.matrix)
      camera.matrixWorldInverse.copy(viewMatrix)
      camera.updateMatrixWorld(true)

      // 执行hit-test
      if (hitTestSourceRef.current) {
        const hitTestResults = frame.getHitTestResults(hitTestSourceRef.current)
        if (hitTestResults.length > 0) {
          const hit = hitTestResults[0]
          const hitPose = hit.getPose(localSpace)

          // 将位姿转换为Three.js矩阵
          const hitMatrix = new THREE.Matrix4().fromArray(hitPose.transform.matrix)
          currentHitMatrixRef.current = hitMatrix

          // 更新十字准星位置
          if (reticleRef.current) {
            reticleRef.current.visible = true
            reticleRef.current.matrix.copy(hitMatrix)
            reticleRef.current.matrix.decompose(
              reticleRef.current.position,
              reticleRef.current.quaternion,
              reticleRef.current.scale
            )
          }
        } else {
          if (reticleRef.current) {
            reticleRef.current.visible = false
          }
          currentHitMatrixRef.current = null
        }
      }

      // 渲染场景
      renderer.render(scene, camera)
    }
  }

  // 放置对象
  const placeObject = () => {
    if (!currentHitMatrixRef.current || !reticleRef.current?.visible) return

    const scene = sceneRef.current
    if (!scene) return

    // 创建对象
    let object
    if (objectType === 'cube') {
      const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2)
      const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 })
      object = new THREE.Mesh(geometry, material)
    } else if (objectType === 'sphere') {
      const geometry = new THREE.SphereGeometry(0.1, 32, 32)
      const material = new THREE.MeshStandardMaterial({ color: 0xff00ff })
      object = new THREE.Mesh(geometry, material)
    } else if (objectType === 'model' && modelUrl) {
      // 对于模型，需要异步加载
      // 这里先创建一个占位符
      const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2)
      const material = new THREE.MeshStandardMaterial({ color: 0xffff00 })
      object = new THREE.Mesh(geometry, material)
      
      // TODO: 加载GLTF模型
    } else {
      return
    }

    // 设置对象位置
    object.matrix.copy(currentHitMatrixRef.current)
    object.matrix.decompose(object.position, object.quaternion, object.scale)
    object.matrixAutoUpdate = false // 固定位置，不自动更新

    scene.add(object)
    placedObjectsRef.current.push(object)

    // 通知父组件
    if (onPlace) {
      const position = new THREE.Vector3()
      object.getWorldPosition(position)
      onPlace(position)
    }
  }

  // 点击事件处理
  useEffect(() => {
    const handleClick = () => {
      if (sessionRef.current) {
        placeObject()
      }
    }

    window.addEventListener('click', handleClick)
    return () => {
      window.removeEventListener('click', handleClick)
    }
  }, [objectType, modelUrl])

  // 暴露启动函数
  useEffect(() => {
    if (window.startARScene) {
      window.startARScene = startAR
    } else {
      window.startARScene = startAR
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        display: 'block',
        zIndex: 0,
      }}
    />
  )
}
