///<reference path="../types/index.d.ts" />
import * as csv from 'csv-string';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as soap from 'soap';
import * as config from './trntxtconfig';
import { FromAndToStation, Station, NrService, DepartureObject, ErrorResponse, DepartureResponse, TrntxtService, ArrivalAndDepartureTimes, ArrivalTime } from './types';
const ignoreStations: [string] = require('../resources/ignore_stations.json');

const stations = loadStations('../resources/station_codes.csv');

const soapUrl = 'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/wsdl.aspx?ver=2014-02-20';
const soapHeader = util.format('<AccessToken><TokenValue>%s</TokenValue></AccessToken>', config.API_KEY
  || console.error("No API key provided. Received: " + config.API_KEY));

function loadStations(filePath: string): Station[] {
  const stationFile = fs.readFileSync(path.join(__dirname, filePath), { encoding: 'utf-8' });
  let csvArray: string[][] = csv.parse(stationFile);
  csvArray = csvArray.filter(arr => {
    return (ignoreStations.indexOf(arr[1]) < 0);
  })
  const output: Station[] = csvArray.map(arr => {
    return {
      stationName: arr[0],
      stationCode: arr[1]
    }
  });
  return output;
}

function findStation(input: string): Station[] {
  let results: Station[] = [];
  input = sanitise(input);
  if (!input || input.length < 3) return results;

  // Find stations whose code matches the input.
  if (input.length === 3) {
    results = stations.filter(station => {
      return station.stationCode === input;
    });
    if (results.length > 0) {
      return results;
    }
  }

  // Results array is still empty. Try and compare names.
  // Filter station list to find station names containing all characters in the right order.
  results = stations.filter(station => {
    let stationName = sanitise(station.stationName);
    station.firstIndex = stationName.indexOf(input[0]);
    station.biggestChunk = biggestChunk(stationName, input);
    for (let i = 0; i < input.length; i++) {
      const index = stationName.indexOf(input[i]);
      if (index === -1) return false;
      stationName = stationName.substring(index + 1);
    }
    return true;
  });

  results = results.sort((stationA, stationB) => {
    if (stationA.firstIndex === stationB.firstIndex) {
      if (stationA.biggestChunk === stationB.biggestChunk) {
        return stationA.stationName.replace(/\(.*\)/, '').length - stationB.stationName.replace(/\(.*\)/, '').length;
      } else {
        return stationB.biggestChunk - stationA.biggestChunk;
      }
    } else {
      return stationA.firstIndex - stationB.firstIndex;
    }
  });

  return results;
}

function getStationNameFromCrs(crs: string): string {
  crs = crs.toUpperCase();
  const results = stations.filter(station => {
    return station.stationCode === crs;
  });
  if (results.length === 0) return null;
  else return results[0].stationName;
}

function biggestChunk(stationName: string, input: string): number {
  for (let i = input.length; i > 0; i--) {
    if (stationName.indexOf(input.substring(0, i - 1)) > -1) return i;
  }
  return 0;
}

function sanitise(input: string): string {
  if (input || input === '') {
    return input
      .toUpperCase()
      .replace('&', 'AND')
      .replace(/[^A-Z0-9]/g, '');
  }
  else return null;
}

function getDepartures(requestedStations: FromAndToStation, callback: (error: ErrorResponse, departureResponse?: DepartureResponse) => void) {
  if (config.API_KEY === undefined) {
    console.error('No API key set!');
    const error = { pageTitle: 'trntxt: ERROR', errorMessage: 'Error: No API key set.' };
    callback(error);
    return;
  }

  getDepartureObject(requestedStations, (err, departureObject) => {
    if (err) {
      console.error(err);
      const errorObject = { pageTitle: 'trntxt: ERROR', errorMessage: 'Error: Getting departures failed.' };
      return callback(errorObject, null);
    }
    const pugResponse: DepartureResponse = {
      departureObject: departureObject,
      pageTitle: 'trntxt: ' + departureObject.fromStation.stationCode,
      fromStation: departureObject.fromStation.stationCode,
      toStation: undefined
    };
    if (departureObject.toStation !== undefined) {
      pugResponse.pageTitle += ' > ' + departureObject.toStation.stationCode;
      pugResponse.toStation = departureObject.toStation.stationCode;
    }
    callback(null, pugResponse);
  });
}

function getDepartureObject(requestedStations: FromAndToStation, callback: (err: Error, departureObject?: DepartureObject) => void) {
  const output: DepartureObject = {};
  output.fromStation = requestedStations.fromStation;
  if (requestedStations.toStation !== undefined) output.toStation = requestedStations.toStation;

  const options: { numRows?: number, crs: string, filterCrs?: string, timeOffset?: number } = {
    crs: requestedStations.fromStation.stationCode
  };
  if (requestedStations.toStation !== undefined) {
    options.filterCrs = requestedStations.toStation.stationCode;
  }

  soap.createClient(soapUrl, (err: Error, client: any) => {
    if (err) return callback(err);
    client.addSoapHeader(soapHeader);
    return client.GetDepartureBoard(options, (err: Error, result: any) => {
      if (err) return callback(err);
      fs.writeFile('public/lastrequest.txt', JSON.stringify(result, null, 2), err => {
        if (err) return console.error(err);
      });

      if (result.GetStationBoardResult.nrccMessages) {
        output.nrccMessages = result.GetStationBoardResult.nrccMessages.message;
        for (let i = 0; i < output.nrccMessages.length; i++) {
          output.nrccMessages[i] = reformatNrccMessage(output.nrccMessages[i]);
        }
      }
      let aTrainServices = result.GetStationBoardResult.trainServices ? result.GetStationBoardResult.trainServices.service : [];
      let aBusServices = result.GetStationBoardResult.busServices ? result.GetStationBoardResult.busServices.service : [];

      // Get another page of departures
      const nextPageOptions = Object.assign({}, options);
      nextPageOptions.timeOffset = 119;
      client.GetDepartureBoard(nextPageOptions, (err: Error, nextPageResult: any) => {
        if (err) {
          // Ignore error, use empty object
          console.error(err);
          nextPageResult = {
            GetStationBoardResult: {
              trainServices: [],
              busServices: []
            }
          };
        }
        if (nextPageResult.GetStationBoardResult.trainServices) {
          aTrainServices = aTrainServices.concat(nextPageResult.GetStationBoardResult.trainServices.service);
        }
        if (nextPageResult.GetStationBoardResult.busServices) {
          aBusServices = aBusServices.concat(nextPageResult.GetStationBoardResult.busServices.service);
        }
        processDarwinServices(aTrainServices, requestedStations, (err, trainServices) => {
          if (err) return callback(err);
          output.trainServices = trainServices;
          processDarwinServices(aBusServices, requestedStations, (err, busServices) => {
            if (err) return callback(err);
            output.busServices = busServices;
            return callback(null, output);
          });
        });
      });
    });
  });
}

function reformatNrccMessage(input: string): string {
  const sanitised = removeHtmlTagsExceptA(input);
  return sanitised.replace('"http://nationalrail.', '"https://www.nationalrail.');
}

function removeHtmlTagsExceptA(input: string): string {
  if (!input) return '';
  return input.replace(/<\/?((([^\/a>]|a[^> ])[^>]*)|)>/ig, '');
}

function processDarwinServices(aServices: [NrService], requestedStations: FromAndToStation, callback: (error: Error, services: TrntxtService[]) => void) {
  const aPromises = [];
  let output: TrntxtService[] = [];
  for (let i = 0; i < aServices.length; i++) {
    output[i] = {};
    output[i].originStation = {
      stationName: aServices[i].origin.location[0].locationName,
      stationCode: aServices[i].origin.location[0].crs
    };
    output[i].destinationStation = {
      stationName: aServices[i].destination.location[0].locationName,
      stationCode: aServices[i].destination.location[0].crs
    };
    output[i].std = aServices[i].std;
    output[i].etd = aServices[i].etd;
    if (aServices[i].platform) {
      output[i].platform = aServices[i].platform;
    } else {
      output[i].platform = null;
    }
    output[i].operator = aServices[i].operator;
    output[i].serviceID = aServices[i].serviceID;
    if (requestedStations.toStation) {
      aPromises.push(makePromiseForService(output[i].serviceID));
    }
  }
  Promise.all(aPromises).then(detailedServices => {
    for (let i = 0; i < detailedServices.length; i++) {
      const arrival = getArrivalTimeForService(detailedServices[i], requestedStations.toStation);
      output[i].sta = arrival.sta;
      output[i].eta = arrival.eta;
      output[i].arrivalStation = arrival.arrivalStation;
      output[i].correctStation = arrival.correctStation;
      const mins = getServiceTime(output[i]);
      output[i].time = formatTime(mins);
    }
    if (requestedStations.toStation) {
      // Remove "phantom" trains: ones that do not provide an arrival time
      output = output.filter((s: TrntxtService) => s.correctStation);
    }
    return callback(null, output);
  }, error => {
    console.error(error);
    return callback(null, output);
  });
}

function getArrivalTimeForService(service: any, toStation: Station) {
  const output: ArrivalTime = {};
  const callingPointArray = service.GetServiceDetailsResult.subsequentCallingPoints.callingPointList[0].callingPoint;
  for (let i = 0; i < callingPointArray.length; i++) {
    if (callingPointArray[i].crs === toStation.stationCode) {
      output.sta = callingPointArray[i].st;
      output.eta = callingPointArray[i].et;
      output.arrivalStation = getStationNameFromCrs(toStation.stationCode);
      output.correctStation = true;
      break;
    } else if (i === callingPointArray.length - 1) {
      output.sta = callingPointArray[i].st;
      output.eta = callingPointArray[i].et;
      output.arrivalStation = getStationNameFromCrs(callingPointArray[i].crs);
      output.correctStation = false;
    }
  }
  return output;
}

function makePromiseForService(serviceId: string): Promise<NrService> {
  const options = { serviceID: serviceId };
  return new Promise((resolve, reject) => {
    soap.createClient(soapUrl, (err: Error, client: any) => {
      client.addSoapHeader(soapHeader);
      client.GetServiceDetails(options, (err: Error, result: any) => {
        if (err) return reject(err);
        return resolve(result);
      });
    });
  });
}

/**
 * Takes a string in hh:mm format and returns the number of minutes
 */
function toMins(time: string): number {
  if (!time) return -1;
  time = time.replace(/([^0-9:])/, '');
  const array = time.split(':');
  if (array.length < 2) return -1;
  const h = parseInt(array[0]);
  const m = parseInt(array[1]);
  if (isNaN(h) || isNaN(m)) {
    return -1;
  } else {
    return (60 * h) + m;
  }
}

/**
 * Takes an object with eta, sta, etd and std properties.
 * 
 * Returns the number of minutes a service should take,
 *   giving preference to the estimated timings
 */
function getServiceTime(timings: ArrivalAndDepartureTimes): number {
  let arrival = toMins(timings.eta);
  if (arrival < 0) {
    arrival = toMins(timings.sta);
  }
  let departure = toMins(timings.etd);
  if (departure < 0) {
    departure = toMins(timings.std);
  }
  if (arrival < 0 || departure < 0) return -1;
  let mins = arrival - departure;
  if (mins < 0) {
    mins += 1440;
  }
  return mins;
}

/**
 * Turns minutes into something like 1h 5m
 */
function formatTime(mins: number): string {
  if (mins < 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  else return m + 'm';
}

export {
  findStation,
  formatTime,
  getDepartures,
  getServiceTime,
  reformatNrccMessage,
  sanitise,
  stations,
  toMins
}
