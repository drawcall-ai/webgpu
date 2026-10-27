// Adapted from Three.js r186 webgpu_compute_texture.html (MIT; see LICENSE).
// https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/examples/webgpu_compute_texture.html
// Scene and compute expressions are upstream; viewport and lifetime are explicit.
import * as THREE from 'three/webgpu';
import { texture, textureStore, Fn, instanceIndex, float, uvec2, vec4 } from 'three/tsl';

export async function createApp(canvas, pixelRatio = 1) {
	const aspect = canvas.width / canvas.height;
	const camera = new THREE.OrthographicCamera( - aspect, aspect, 1, - 1, 0, 2 );
	camera.position.z = 1;
	const scene = new THREE.Scene();

	// texture

	const width = 512, height = 512;

	const storageTexture = new THREE.StorageTexture( width, height );
	//storageTexture.minFilter = THREE.LinearMipMapLinearFilter;

	// create function

	const computeTexture = Fn( ( { storageTexture } ) => {

		const posX = instanceIndex.mod( width );
		const posY = instanceIndex.div( width );
		const indexUV = uvec2( posX, posY );

		// https://www.shadertoy.com/view/Xst3zN

		const x = float( posX ).div( 50.0 );
		const y = float( posY ).div( 50.0 );

		const v1 = x.sin();
		const v2 = y.sin();
		const v3 = x.add( y ).sin();
		const v4 = x.mul( x ).add( y.mul( y ) ).sqrt().add( 5.0 ).sin();
		const v = v1.add( v2, v3, v4 );

		const r = v.sin();
		const g = v.add( Math.PI ).sin();
		const b = v.add( Math.PI ).sub( 0.5 ).sin();

		textureStore( storageTexture, indexUV, vec4( r, g, b, 1 ) ).toWriteOnly();

	} );

	// compute

	const computeNode = computeTexture( { storageTexture } ).compute( width * height );

	const material = new THREE.MeshBasicNodeMaterial( { color: 0x00ff00 } );
	material.colorNode = texture( storageTexture );

	const plane = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), material );
	scene.add( plane );
	const renderer = new THREE.WebGPURenderer( { antialias: true, canvas } );
	const outputWidth = canvas.width, outputHeight = canvas.height;
	renderer.setPixelRatio( pixelRatio );
	renderer.setSize( outputWidth, outputHeight );

	async function dispose() {
		plane.geometry.dispose();
		material.dispose();
		storageTexture.dispose();
		await renderer.dispose();
	}

	try {
		await renderer.init();
		renderer.compute( computeNode );
	} catch (error) {
		await dispose();
		throw error;
	}

	function render() {
		renderer.render( scene, camera );
	}

	function resize(width, height) {
		renderer.setSize( width, height );
		const aspect = width / height;
		const frustumHeight = camera.top - camera.bottom;
		camera.left = - frustumHeight * aspect / 2;
		camera.right = frustumHeight * aspect / 2;
		camera.updateProjectionMatrix();
		render();
	}

	return { render, resize, dispose };
}
