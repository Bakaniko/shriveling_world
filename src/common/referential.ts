namespace shriveling {
    'use strict';

    function Cartographic2ECEF(pos: Cartographic): Coordinate {
        let radius = Configuration.earthRadiusMeters + pos.height;
        return new Coordinate(
            Math.cos(pos.longitude) * radius * Math.cos(pos.latitude),
            Math.sin(pos.longitude) * radius * Math.cos(pos.latitude),
            Math.sin(pos.latitude) * radius,
        );
    }

    function ECEF2Cartographic(pos: Coordinate): Cartographic {
        let out = new Cartographic();
        let radius = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
        out.height = radius - Configuration.earthRadiusMeters;
        if (radius > 0) {
            out.longitude = Math.atan2(pos.y, pos.x);
            let sin = Math.sin(out.longitude);
            if (Math.abs(sin) > 1e-20) {
                out.latitude = Math.atan2(pos.z, pos.y / sin);
            } else {
                let cos = Math.cos(out.longitude);
                out.latitude = Math.atan2(pos.z, pos.x / cos);
            }
        }
        return out;
    }

    export class Coordinate {
        public x: number;
        public y: number;
        public z: number;

        public static fromJSON(value: any): any {
            return Generic_fromJSON(Coordinate, value.data);
        }

        public static dot(vec1: Coordinate, vec2: Coordinate): number {
            return vec1.x * vec2.x + vec1.y * vec2.y + vec1.z * vec2.z;
        }

        public static multiplyVector(vec1: Coordinate, vec2: Coordinate, result?: Coordinate): Coordinate {
            result = result instanceof Coordinate ? result : new Coordinate();
            result.x = vec1.y * vec2.z - vec1.z * vec2.y;
            result.y = vec1.z * vec2.x - vec1.x * vec2.z;
            result.z = vec1.x * vec2.y - vec1.y * vec2.x;
            return result;
        }

        public static scalar(vec1: Coordinate, coef: number, result?: Coordinate): Coordinate {
            result = result instanceof Coordinate ? result : new Coordinate();
            result.x = vec1.x * coef;
            result.y = vec1.y * coef;
            result.z = vec1.z * coef;
            return result;
        }

        public static add(vec1: Coordinate, vec2: Coordinate, result?: Coordinate): Coordinate {
            result = result instanceof Coordinate ? result : new Coordinate();
            result.x = vec1.x + vec2.x;
            result.y = vec1.y + vec2.y;
            result.z = vec1.z + vec2.z;
            return result;
        }

        public static distance(vec1: Coordinate, vec2: Coordinate): number {
            return Math.sqrt((vec1.x - vec2.x) * (vec1.x - vec2.x) +
                (vec1.y - vec2.y) * (vec1.y - vec2.y) +
                (vec1.z - vec2.z) * (vec1.z - vec2.z));
        }

        public constructor(x: number = 0, y: number = 0, z: number = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        public normalize(): Coordinate {
            let distance = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
            if (distance > 1e-13) {
                this.x = this.x / distance;
                this.y = this.y / distance;
                this.z = this.z / distance;
            }
            return this;
        }

        public dot(vec2): number {
            return Coordinate.dot(this, vec2);
        }

        public multiplyVector(vec2: Coordinate, result?: Coordinate): Coordinate {
            return Coordinate.multiplyVector(this, vec2, result);
        }

        public scalar(coef: number, result?: Coordinate): Coordinate {
            return Coordinate.scalar(this, coef, result);
        }

        public add(vec2: Coordinate, result?: Coordinate): Coordinate {
            return Coordinate.add(this, vec2, result);
        }
        public distance(vec2: Coordinate): number {
            return Coordinate.distance(this, vec2);
        }
        public toJSON(): { ctor: string, data: any } {
            return Generic_toJSON('Coordinate', this);
        }
    }

    var scrapCoordinate = new Coordinate();
    var scrapCoordinate2 = new Coordinate();

    export interface INEDLocalGLSL {
        ned2ECEF0: number[];
        ned2ECEF1: number[];
        ned2ECEF2: number[];
        summit: number[];
    }

    export class NEDLocal {
        public cartoRef: Cartographic;
        private _ECEFRef: Coordinate;
        private _matECEF2NED: Coordinate[];
        private _matNED2ECEF: Coordinate[];
        private _glslData: INEDLocalGLSL;

        public static fromJSON(value: any): any {
            return Generic_fromJSON(NEDLocal, value.data);
        }

        public constructor(summit: Cartographic = ZERO_CARTOGRAPHIC) {
            let sinLong = Math.sin(summit.longitude);
            let cosLong = Math.cos(summit.longitude);
            let sinLat = Math.sin(summit.latitude);
            let cosLat = Math.cos(summit.latitude);
            this.cartoRef = summit;
            this._ECEFRef = Cartographic2ECEF(summit);

            this._matECEF2NED = [];
            this._matECEF2NED.push(new Coordinate(-cosLong * sinLat, -sinLong * sinLat, cosLat)); // north
            this._matECEF2NED.push(new Coordinate(-sinLong, cosLong, 0)); // east
            this._matECEF2NED.push(new Coordinate(-cosLong * cosLat, - sinLong * cosLat, -sinLat)); // down

            this._matNED2ECEF = []; // transposate
            this._matNED2ECEF.push(new Coordinate(-cosLong * sinLat, -sinLong, -cosLong * cosLat));
            this._matNED2ECEF.push(new Coordinate(-sinLong * sinLat, cosLong, - sinLong * cosLat));
            this._matNED2ECEF.push(new Coordinate(cosLat, 0, -sinLat));
        }

        public cartographic2NED(pos: Cartographic): Coordinate {
            let ecefPos = Cartographic2ECEF(pos);
            let relativeECEF = ecefPos.add(this._ECEFRef.scalar(-1, scrapCoordinate), scrapCoordinate);
            return new Coordinate(
                this._matECEF2NED[0].dot(relativeECEF),
                this._matECEF2NED[1].dot(relativeECEF),
                this._matECEF2NED[2].dot(relativeECEF),
            );
        }

        public NED2Cartographic(pos: Coordinate): Cartographic {
            let relativeECEF = new Coordinate(
                this._matNED2ECEF[0].dot(pos),
                this._matNED2ECEF[1].dot(pos),
                this._matNED2ECEF[2].dot(pos),
            );
            let ecefPos = relativeECEF.add(this._ECEFRef, scrapCoordinate);
            return ECEF2Cartographic(ecefPos);
        }

        public getClock(pos: Cartographic): number {
            let temp = this.cartographic2NED(pos);
            return Math.atan2(temp.y, temp.x);
        }

        public direction2Position
            (clock: number, elevation: number, result?: Coordinate): Coordinate {
            result = result instanceof Coordinate ? result : new Coordinate();
            let cosEl = Math.cos(elevation);
            let sinEl = Math.sin(elevation);
            let cosClock = Math.cos(clock);
            let sinClock = Math.sin(clock);
            result.x = cosEl * cosClock; // cos elevation * cos clock
            result.y = cosEl * sinClock; // cos elevation * sin clock
            result.z = sinEl; // sin elevation
            return result;
        }

        public project(clock: number, elevation: number, distance: number): Cartographic {
            this.direction2Position(clock, elevation, scrapCoordinate2).scalar(distance, scrapCoordinate2);
            return this.NED2Cartographic(scrapCoordinate2);
        }

        public toJSON(): { ctor: string, data: any } {
            return Generic_toJSON('NEDLocal', this);
        }

        get ned2ECEFMatrix(): INEDLocalGLSL {
            if (this._glslData === undefined) {
                let mat = this._matECEF2NED;
                let summit = this.cartoRef.toThreeGLSL();
                this._glslData = {
                    ned2ECEF0: [mat[0].x, mat[0].y, mat[0].z],
                    ned2ECEF1: [mat[1].x, mat[1].y, mat[1].z],
                    ned2ECEF2: [mat[2].x, mat[2].y, mat[2].z],
                    summit: summit,
                };
            }
            return this._glslData;
        }
    }
}