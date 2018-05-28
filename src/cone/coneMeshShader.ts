namespace shriveling {
    'use strict';
    const forbiddenAttributes = ['referential', 'position', 'transports'];

    interface IShaderElevation {
        [year: string]: Float32Array;
    }

    let _cones: ConeMeshShader[];
    let _uvsArr: Float32Array;
    let _indexesArr: Uint16Array;

    let _localLimitsLookup: { [x: string]: { clock: number, distance: number }[] };
    let _conesWithoutDisplay: ConeMeshShader[] = [];
    let _cityCodeOrder: string[];
    let uuid: string = undefined;
    let _dirtyLimits = false;
    let _tickCount = 0;
    let _ready = false;
    let _width: number;
    let _height: number;

    let _gpgpu: { [x: string]: GPUComputer } = {};

    let _clocks: Float32Array; // ok
    let _elevations: IShaderElevation;

    function fullCleanArrays(): void {
        _localLimitsLookup = {};
        _cityCodeOrder = [];
        _clocks = new Float32Array(0);
        _elevations = {};
        _uvsArr = new Float32Array(0);
        _indexesArr = new Uint16Array(0);
    }
    fullCleanArrays();

    function localLimitsRaw(
        boundaries: Cartographic[][], referential: NEDLocal): { clock: number, distance: number }[] {
        let allPoints: Coordinate[] = [];
        boundaries.forEach((boundary) => {
            boundary.forEach((position) => {
                allPoints.push(referential.cartographic2NED(position));
            });
        });
        let resultat: { clock: number, distance: number }[] = [];
        allPoints.forEach((pos) => {
            let clook = Math.atan2(pos.y, pos.x);
            let distance = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
            resultat.push(
                { clock: clook, distance: distance },
                { clock: clook + Configuration.TWO_PI, distance: distance },
                { clock: clook - Configuration.TWO_PI, distance: distance },
            );
        });
        resultat.sort((a, b) => a.clock - b.clock);
        return resultat;
    }

    function localLimitsFunction(tab: { clock: number, distance: number }[], coneStep = Configuration.coneStep): (x: number) => number {
        let clockDistance = tab.reduce(
            (result, current) => {
                let clockClass = Math.floor(current.clock / coneStep) * coneStep;
                result[clockClass] = result[clockClass] === undefined ? current.distance : Math.min(result[clockClass], current.distance);
                return result;
            },
            {});
        let temporaire: { clock: number, distance: number }[] = [];
        for (let clockString in clockDistance) {
            if (clockDistance.hasOwnProperty(clockString)) {
                temporaire.push({ clock: parseFloat(clockString), distance: clockDistance[clockString] });
            }
        }
        return extrapolator(temporaire, 'clock', 'distance');
    }

    // quand on change constep!!
    function regenerateFromConeStep(): void {
        const step = Configuration.coneStep;
        let uvs: number[] = [];
        let clocks: number[] = [];
        let index: number[] = [];
        let x: number, y: number, ib: number;
        for (let i = 0; i < Configuration.TWO_PI; i += step) {
            x = Math.cos(i);
            y = Math.sin(i);
            uvs.push(x, y);
            clocks.push(i);
        }
        let length = clocks.length;
        uvs.push(.5, .5, .5, .5);
        clocks.push(-1);
        for (let i = 0; i < length; i++) {
            ib = (i + 1) % length;
            index.push(i, ib, length, i, ib, length + 1);
        }
        _clocks = new Float32Array(clocks);
        _uvsArr = new Float32Array(uvs);
        _indexesArr = new Uint16Array(index);

        _width = _clocks.length;
        let cacheBoundary: { [cityCode: string]: Float32Array } = {};
        for (let cityCode in _localLimitsLookup) {
            if (_localLimitsLookup.hasOwnProperty(cityCode)) {
                let localBoundaryFunction = localLimitsFunction(_localLimitsLookup[cityCode]);
                let tempTab = new Float32Array(_width);
                for (let i = 0; i < _width; i++) {
                    tempTab[i] = localBoundaryFunction(_clocks[i]);
                }
                cacheBoundary[cityCode] = tempTab;
            }
        }
        let boundaries = new Float32Array(_width * _height);
        for (let i = 0; i < _height; i++) {
            boundaries.set(cacheBoundary[_cityCodeOrder[i]], i * _width);
        }

        console.log(_width, _height);
        let options = {
            u_clocks: { src: _clocks, width: _width, height: 1 },
            u_boundaryLimits: { src: boundaries, width: _width, height: _height },
        };
        _gpgpu.positions.updateTextures(options);
    }

    function updateElevations(): void {
        let year = Configuration.year;
        _conesWithoutDisplay = [];
        if (!_elevations.hasOwnProperty(year)) {
            let temp = new Float32Array(_height);
            for (let i = 0; i < _height; i++) {
                let elevation = _cones[i].getElevation(year);
                if (elevation === undefined) {
                    _conesWithoutDisplay.push(_cones[i]);
                    elevation = Math.PI / 2 - 0.0000000001;
                }
                temp[i] = elevation;
            }
            _elevations[year] = temp;
        }
        let options = {
            u_elevations: { src: _elevations[year], width: 1, height: _height },
        };
        _gpgpu.positions.updateTextures(options);
    }

    function updateWithLimits(): void {
        let withLimits = new Uint8Array(_height);
        for (let i = 0; i < _height; i++) {
            withLimits[i] = _cones[i].withLimits ? 1 : 0;
        }
        let options = {
            u_withLimits: { src: withLimits, width: 1, height: _height },
        };
        _gpgpu.positions.updateTextures(options);
    }

    function computation(withNormals: boolean): void {
        let uniforms: { [x: string]: number | ArrayBufferView } = {};
        uniforms.longueurMaxi = Configuration.extrudedHeight;
        uniforms.threeRadius = Configuration.THREE_EARTH_RADIUS;
        uniforms.earthRadius = Configuration.earthRadiusMeters;
        uniforms.referenceEquiRectangular = Configuration.referenceEquiRectangularArray;
        uniforms.lambda0 = Configuration.lambda0Mercator;
        uniforms.representationInit = Configuration.projectionInit;
        uniforms.representationEnd = Configuration.projectionEnd;
        uniforms.percentRepresentation = Configuration.percentProjection;
        _gpgpu.positions.updateUniforms(uniforms);
        let allPositions = _gpgpu.positions.calculate(_width, _height)[0];

        let options = {
            points: { src: allPositions, width: _width, height: _height },
        };
        _gpgpu.boundingSphere.updateTextures(options);
        let temp = _gpgpu.boundingSphere.calculate(1, _height);
        let boundingBoxes = temp[0];
        let lastPosition = temp[1];

        let finalPositions = new Float32Array((_width + 1) * _height * 4);
        let offset: number;
        for (let i = 0; i < _height; i++) {
            offset = i * (_width + 1) * 4;
            finalPositions.set(allPositions.subarray(i * _width * 4, (i + 1) * _width * 4), offset);
            finalPositions.set(lastPosition.subarray(i * 4, (i + 1) * 4), offset + 4 * _width);
        }

        let normals: Float32Array;
        if (withNormals === true) {
            options = {
                points: { src: finalPositions, width: _width + 1, height: _height },
            };
            _gpgpu.rawNormals.updateTextures(options);
            let raws = _gpgpu.rawNormals.calculate(_width + 1, _height)[0];

            options['rawNormals'] = { src: raws, width: _width + 1, height: _height };
            _gpgpu.normals.updateTextures(options);
            normals = _gpgpu.normals.calculate(_width + 1, _height)[0];
        }
        let boundingBox: Float32Array;
        let norms: Float32Array;
        for (let i = 0; i < _height; i++) {
            boundingBox = boundingBoxes.subarray(i * 4, (i + 1) * 4);
            norms = withNormals === true ? normals.subarray(i * (_width + 1) * 4, (i + 1) * (_width + 1) * 4) : undefined;
            _cones[i].setGeometry(finalPositions.subarray(i * (_width + 1) * 4, (i + 1) * (_width + 1) * 4), boundingBox, norms);
        }
    }
    let start = performance.now();
    function showStats(info: string): void {
        let end = performance.now();

        console.log(info, (end - start) / 1000);
        start = performance.now();
    }
    export class ConeMeshShader extends PseudoCone {

        public otherProperties: any;
        private _withLimits: boolean;
        private _cityCode: string;
        private _position: Cartographic;
        private _directions: { [year: string]: number };

        public static generateCones(lookup: ILookupTownTransport, bboxes: IBBox[]): Promise<ConeMeshShader[]> {
            _ready = false;
            _cones = [];
            fullCleanArrays();
            let promise = new Promise((resolve, reject) => {
                if (uuid === undefined) {
                    Promise.all([
                        GPUComputer.GPUComputerFactory(
                            Shaders.getShader('coneMeshShader', 'fragment'), {
                                u_clocks: 'R32F',
                                u_elevations: 'R32F',
                                u_boundaryLimits: 'R32F',
                                u_summits: 'RGB32F',
                                u_ned2ECEF0s: 'RGB32F',
                                u_ned2ECEF1s: 'RGB32F',
                                u_ned2ECEF2s: 'RGB32F',
                                u_withLimits: 'R8',
                            },
                            1).then(
                            (instance) => {
                                _gpgpu.positions = instance;
                                return instance;
                            }),
                        GPUComputer.GPUComputerFactory(
                            Shaders.getShader('rawVerticeNormal', 'fragment'), {
                                points: 'RGBA32F',
                            },
                            1).then(
                            (instance) => {
                                _gpgpu.rawNormals = instance;
                                return instance;
                            }),
                        GPUComputer.GPUComputerFactory(
                            Shaders.getShader('verticeNormal', 'fragment'), {
                                points: 'RGBA32F',
                            },
                            1).then(
                            (instance) => {
                                _gpgpu.normals = instance;
                                return instance;
                            }),
                        GPUComputer.GPUComputerFactory(
                            Shaders.getShader('boundingSphere', 'fragment'), {
                                points: 'RGBA32F',
                            },
                            2).then(
                            (instance) => {
                                _gpgpu.boundingSphere = instance;
                                return instance;
                            }),
                    ]).then(() => {
                        uuid = Configuration.addEventListener(
                            'heightRatio intrudedHeightRatio coneStep  referenceEquiRectangular lambda0Mercator THREE_EARTH_RADIUS ' +
                            'projectionType projectionPercent year tick',
                            (name: string, value: any) => {
                                if (_ready === true) {
                                    switch (name) {
                                        case 'coneStep':
                                            _clocks = new Float32Array(0);
                                            _elevations = {};
                                            _uvsArr = new Float32Array(0);
                                            _indexesArr = new Uint16Array(0);
                                            regenerateFromConeStep();
                                            updateElevations();
                                            updateWithLimits();
                                            computation(true);
                                            break;
                                        case 'year':
                                            updateElevations();
                                            updateWithLimits();
                                            computation(true);
                                            break;
                                        case 'tick':
                                            if (_dirtyLimits === true && _tickCount > 10) {
                                                updateWithLimits();
                                                computation(true);
                                                _tickCount = 0;
                                                _dirtyLimits = false;
                                            } else {
                                                _tickCount++;
                                            }
                                            break;
                                        case 'projectionBegin':
                                            computation(true);
                                            break;
                                        default:
                                            computation(false);
                                    }
                                }
                            });
                        resolve(0);
                    });
                } else {
                    resolve(0);
                }
            });

            return promise.then(() => {
                let summits: number[] = [];
                let ned2ECEF0: number[] = [];
                let ned2ECEF1: number[] = [];
                let ned2ECEF2: number[] = [];
                for (let cityCode in lookup) {
                    if (lookup.hasOwnProperty(cityCode)) {
                        let townTransport = lookup[cityCode];
                        let position = townTransport.referential.cartoRef;
                        let referentialGLSL = townTransport.referential.ned2ECEFMatrix;
                        let transports = townTransport.transports;
                        _localLimitsLookup[cityCode] = localLimitsRaw(matchingBBox(position, bboxes), townTransport.referential);
                        let commonProperties = {};
                        for (let attribute in townTransport) {
                            if (townTransport.hasOwnProperty(attribute) && forbiddenAttributes.indexOf(attribute) === -1) {
                                commonProperties[attribute] = townTransport[attribute];
                            }
                        }
                        for (let transportName in transports) {
                            if (transports.hasOwnProperty(transportName)) {
                                let directions = transports[transportName];
                                let specificProperties =
                                    Object.assign({}, commonProperties, { directions: directions, transport: transportName });
                                _cones.push(new ConeMeshShader(cityCode, position, directions, specificProperties));
                                _cityCodeOrder.push(cityCode);
                                summits.push(...referentialGLSL.summit);
                                ned2ECEF0.push(...referentialGLSL.ned2ECEF0);
                                ned2ECEF1.push(...referentialGLSL.ned2ECEF1);
                                ned2ECEF2.push(...referentialGLSL.ned2ECEF2);
                            }
                        }
                    }
                }
                _height = _cones.length;
                let options = {
                    u_summits: { src: new Float32Array(summits), width: 1, height: _height },
                    u_ned2ECEF0s: { src: new Float32Array(ned2ECEF0), width: 1, height: _height },
                    u_ned2ECEF1s: { src: new Float32Array(ned2ECEF1), width: 1, height: _height },
                    u_ned2ECEF2s: { src: new Float32Array(ned2ECEF2), width: 1, height: _height },
                };
                _gpgpu.positions.updateTextures(options);
                regenerateFromConeStep();
                updateElevations();
                updateWithLimits();
                computation(true);
                _ready = true;
                return [..._cones];
            });
        }

        public dispose(): void {
            super.dispose();
        }

        public setGeometry(positions: Float32Array, boundingSphereData: Float32Array, normals?: Float32Array): void {
            let bufferedGeometry = <THREE.BufferGeometry>this.geometry;
            if (_conesWithoutDisplay.indexOf(this) === -1) {
                let interleavedBuffer = (<THREE.InterleavedBufferAttribute>bufferedGeometry.getAttribute('position')).data;
                interleavedBuffer.set(positions, 0);
                interleavedBuffer.needsUpdate = true;
                let center = bufferedGeometry.boundingSphere.center;
                center.setX(boundingSphereData[0]);
                center.setY(boundingSphereData[1]);
                center.setZ(boundingSphereData[2]);
                bufferedGeometry.boundingSphere.radius = boundingSphereData[3];
                if (normals !== undefined) {
                    interleavedBuffer = (<THREE.InterleavedBufferAttribute>bufferedGeometry.getAttribute('normal')).data;
                    interleavedBuffer.set(normals, 0);
                    interleavedBuffer.needsUpdate = true;
                }
                if (bufferedGeometry.drawRange.count !== _indexesArr.length) {
                    bufferedGeometry.getIndex().set(_indexesArr);
                    bufferedGeometry.getIndex().needsUpdate = true;
                    let bufferAttribute = (<THREE.BufferAttribute>bufferedGeometry.getAttribute('uv'));
                    bufferAttribute.set(_uvsArr);
                    bufferAttribute.needsUpdate = true;
                    bufferedGeometry.setDrawRange(0, _indexesArr.length);
                }
            } else {
                bufferedGeometry.setDrawRange(0, 0);
            }
        }

        public getElevation(year: string): number {
            return this._directions[year];
        }

        private constructor(cityCode: string, position: Cartographic, directions: ILookupDirection, properties: any) {
            const interleavedBufferPosition = new THREE.InterleavedBuffer(new Float32Array(400 * 4), 4).setDynamic(true);
            const interleavedBufferAttributePosition = new THREE.InterleavedBufferAttribute(interleavedBufferPosition, 3, 0, false);
            const interleavedBufferNormal = new THREE.InterleavedBuffer(new Float32Array(400 * 4), 4).setDynamic(true);
            const interleavedBufferAttributeNormal = new THREE.InterleavedBufferAttribute(interleavedBufferNormal, 3, 0, false);
            const bufferGeometry = new THREE.BufferGeometry();
            bufferGeometry.addAttribute('position', interleavedBufferAttributePosition);
            bufferGeometry.addAttribute('normal', interleavedBufferAttributeNormal);
            bufferGeometry.addAttribute('uv', new THREE.BufferAttribute(new Float32Array(400 * 2), 2).setDynamic(true));
            bufferGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array(400 * 6), 1).setDynamic(true));
            bufferGeometry.setDrawRange(0, 0);
            bufferGeometry.computeBoundingSphere();
            bufferGeometry.boundingSphere = new THREE.Sphere();
            super(bufferGeometry, Configuration.BASIC_CONE_MATERIAL.clone());
            this._cityCode = cityCode;
            this._position = position;
            this.otherProperties = properties;
            this._directions = {};
            this._withLimits = true;
            this.visible = true;

            for (let year in directions) {
                if (directions.hasOwnProperty(year)) {
                    this._directions[year] = directions[year][0].elevation;
                }
            }
        }

        get cityCode(): string {
            return this._cityCode;
        }
        get cartographicPosition(): Cartographic {
            return this._position;
        }

        get withLimits(): boolean {
            return this._withLimits;
        }

        set withLimits(value: boolean) {
            if (value !== this._withLimits) {
                _dirtyLimits = true;
                this._withLimits = value;
            }
        }
    }
}