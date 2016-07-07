(function () {

    var elasticsearchTableauDataTypeMap = {
        string: 'string',
        float: 'float',
        long: 'int',
        integer: 'int',
        date: 'datetime',
        boolean: 'bool',
        geo_point: 'string'
    },
        elasticsearchFields = [],
        elasticsearchFieldsMap = {},
        elasticsearchAggsMap = {},
        elasticsearchDateFields = [],
        elasticsearchGeoPointFields = [],
        elasticsearchIndices = [],
        elasticsearchTypes = [],
        startTime,
        endTime,
        queryEditor,
        aggQueryEditor,
        parserEditor;


    var addElasticsearchField = function (name, esType, format, hasLatLon) {

        if (_.isUndefined(elasticsearchTableauDataTypeMap[esType])) {
            console.log("Unsupported Elasticsearch type: " + esType + " for field: " + name);
            return;
        }

        elasticsearchFields.push({ name: name, dataType: elasticsearchTableauDataTypeMap[esType] });
        elasticsearchFieldsMap[name] = { type: elasticsearchTableauDataTypeMap[esType], format: format };

        if (esType == 'date') {
            elasticsearchDateFields.push(name);
        }

        if (esType == 'geo_point') {
            elasticsearchGeoPointFields.push({ name: name, hasLatLon: hasLatLon });
            addElasticsearchField(name + '_latitude', 'float');
            addElasticsearchField(name + '_longitude', 'float');
        }
    }

    var getElasticsearchTypeMapping = function (connectionData, cb) {

        console.log('[getElasticsearchTypeMapping] invoking...');

        if(!connectionData.elasticsearchUrl){
            return abort("Must provide valid Elasticsearch URL");
        }
        if(!connectionData.elasticsearchIndex){
            return abort("Must provide valid Elasticsearch Index");
        }
        if(!connectionData.elasticsearchType){
            return abort("Must provide valid Type");
        }

        addElasticsearchField('_id', 'string');
        addElasticsearchField('_sequence', 'integer');

        $.ajax(connectionData.elasticsearchUrl + '/' + connectionData.elasticsearchIndex + '/' +
            connectionData.elasticsearchType + '/_mapping', {
                context: connectionData,
                dataType: 'json',
                beforeSend: function (xhr) {
                    if (connectionData.elasticsearchAuthenticate && tableau.username) {
                        xhr.setRequestHeader("Authorization", "Basic " +
                            btoa(tableau.username + ":" + tableau.password));
                    }

                },
                success: function (data) {
                    clearError();

                    var connectionData = this;
                    console.log('[getElasticsearchTypeMapping] ', connectionData);

                    var indexName = connectionData.elasticsearchIndex;

                    if (cb) {
                        cb(null, data, connectionData);
                    }


                },
                error: function (xhr, ajaxOptions, err) {
                    var err;
                    if (xhr.status == 0) {
                        err = 'Unable to get Elasticsearch types, unable to connect to host or CORS request was denied';
                    }
                    else {
                        err = 'Unable to get Elasticsearch types, status code: ' + xhr.status + '; ' + xhr.responseText + '\n' + err;
                    }

                    console.error(err);

                    if (cb) {
                        cb(err);
                    }

                }
            });
    }

    function abort(errorMessage, kill) {

        $('#divMessage').css('display', 'none');

        $('#divError').css('display', 'block');
        $('#errorText').text(errorMessage);

        $('html, body').animate({
            scrollTop: $("#divError").offset().top
        }, 500);

        console.error(errorMessage);
        if (kill) {
            tableau.abortWithError(errorMessage);
        }

    }

    function clearError() {
        $('#divError').css('display', 'none');
    }

    //
    // Connector definition
    //

    var myConnector = tableau.makeConnector();

    myConnector.getColumnHeaders = function () {

        var connectionData;

        try {
            connectionData = JSON.parse(tableau.connectionData);
        }
        catch (ex) {
            abort("Error parsing tableau connection data: \n", ex);
            return;
        }

        console.log('getColumnHeaders called, headers: ' + _.pluck(connectionData.fields, 'name').join(', '));
        tableau.headersCallback(_.pluck(connectionData.fields, 'name'), _.pluck(connectionData.fields, 'dataType'));


    };

    var totalCount = 0,
        searchHitsTotal = -1;

    myConnector.getTableData = function (lastRecordToken) {

        console.log('[getTableData] lastRecordToken: ' + lastRecordToken);
        var connectionData = JSON.parse(tableau.connectionData);

        if (connectionData.elasticsearchAuthenticate) {
            console.log('[getTableData] Using HTTP Basic Auth, username: ' +
                tableau.username + ', password: ' + tableau.password);
        }

        if (connectionData.elasticsearchResultMode == "search") {
            // First time this is invoked
            if (!lastRecordToken) {
                console.log('[getTableData] open search scroll window...');
                openSearchScrollWindow(function (err, scrollId) {
                    console.log('[getTableData] opened scroll window, scroll id: ' + scrollId);
                });
            }
            else {
                console.log('[getTableData] getting next scroll result...');

                getNextScrollResult(lastRecordToken, function (err, results) {
                    console.log('[getTableData] processed next scroll result, count: ' + results.length);
                })
            }
        }
        if (connectionData.elasticsearchResultMode == "aggregation") {

            console.log('[getTableData] getting aggregation response');

            getAggregationResponse(lastRecordToken);

        }
    };

    myConnector.init = function () {

        console.log('[connector.init] fired');

        if (tableau.phase == tableau.phaseEnum.interactivePhase) {
            $('.no-tableau').css('display', 'none');
            $('.tableau').css('display', 'block');

            initUIControls();
        }

        tableau.initCallback();
    }

    myConnector.shutdown = function () {
        endTime = moment();
        var runTime = endTime.diff(startTime) / 1000;
        $('#myPleaseWait').modal('hide');

        $('#divError').css('display', 'none');
        $('#divMessage').css('display', 'block');
        $('#messageText').text(totalCount + ' total rows retrieved, in: ' + runTime + ' (s)');

        $('html, body').animate({
            scrollTop: $("#divMessage").offset().top
        }, 500);

        console.log('[connector.shutdown] callback...');
        tableau.shutdownCallback();
    };

    tableau.registerConnector(myConnector);

    //
    // Setup connector UI
    //

    $(document).ready(function () {
        console.log('[$.document.ready] fired...');
    });

    var initUIControls = function () {

        queryEditor = ace.edit("divElasticsearchQueryEditor");
        queryEditor.setTheme("ace/theme/github");
        queryEditor.getSession().setMode("ace/mode/json");

        $('#cbUseQuery').change(function () {
            if ($(this).is(":checked")) {
                $('#divQuery').css('display', 'block');
            }
            else {
                $('#divQuery').css('display', 'none');
                $('#inputUsername').val('');
                $('#inputPassword').val('');
            }

            updateTableauConnectionData();
        });

        $('#cbUseBasicAuth').change(function () {
            if ($(this).is(":checked")) {
                $('.basic-auth-control').css('display', 'block');
            }
            else {
                $('.basic-auth-control').css('display', 'none');
                queryEditor.setValue('');
            }

            updateTableauConnectionData();
        });

        var handleResultModeCheckbox = function () {
            var mode = $("input:radio[name='resultmode']:checked").val();

            switch (mode) {
                case "search":

                    console.log("[initUIControls] Showing search result mode controls");

                    $("#divAggregationResultControls").hide();
                    $("#divSearchResultControls").show();
                    break;

                case "aggregation":

                    console.log("[initUIControls] Showing aggregation result mode controls");

                    $("#divSearchResultControls").hide();
                    $("#divAggregationResultControls").show();
                    break;
            }
        };

        $(document).on("change", "input:radio[name='resultmode']", handleResultModeCheckbox);

        handleResultModeCheckbox.call($("input:radio[name='resultmode']"));


        aggQueryEditor = ace.edit("divElasticsearchAggQueryEditor");
        aggQueryEditor.setTheme("ace/theme/github");
        aggQueryEditor.getSession().setMode("ace/mode/json");


        parserEditor = ace.edit("inputParserFunction");
        parserEditor.setTheme("ace/theme/github");
        parserEditor.getSession().setMode("ace/mode/json");

        $('#cbUseAggregationQuery').change(handleUseAggregationQueryCheckbox);

        var handleUseAggregationQueryCheckbox = function () {
            console.log('[initUIControls] handling use aggregation query CB change');

            if ($(this).is(":checked")) {
                $('#divAggregationQuery').css('display', 'block');
            }
            else {
                $('#divAggregationQuery').css('display', 'none');
                aggQueryEditor.setValue('');
                parserEditor.setValue('');
            }

            updateTableauConnectionData();
        }

        handleUseAggregationQueryCheckbox.call($('#cbUseAggregationQuery'));

        $("#testButton").click(function(e){

            e.preventDefault();

            var connectionData = getTableauConnectionData();

            var aggsQuery;
            try {
                aggsQuery = JSON.parse(connectionData.elasticsearchAggQuery);
            }
            catch (err) {
                return abort("Error parsing aggregation query, error: " + err);
            }

            cd = updateTableauConnectionData();

            var connectionUrl = connectionData.elasticsearchUrl + '/' + connectionData.elasticsearchIndex + '/' +
                connectionData.elasticsearchType + '/_search';

            var requestData = JSON.parse(connectionData.elasticsearchAggQuery);

            var xhr = $.ajax({
                url: connectionUrl,
                method: 'POST',
                processData: false,
                data: JSON.stringify(requestData),
                dataType: 'json',
                beforeSend: function (xhr) {
                    if (connectionData.elasticsearchAuthenticate && tableau.username) {
                        xhr.setRequestHeader("Authorization", "Basic " +
                            btoa(tableau.username + ":" + tableau.password));
                    }

                },
                success: function (data) {

                  var func = new Function('data', cd.parserFunction);

                  tableau.parserMethod = func;

                  var result = func(data);

                  console.log(result);

                },
                error: function (xhr, ajaxOptions, err) {
                  console.log('error');
                }
            });

        });

        $("#submitButton").click(function (e) { // This event fires when a button is clicked
            e.preventDefault();

            var connectionData = getTableauConnectionData();

            switch (connectionData.elasticsearchResultMode) {
                case "search":
                    // Retrieve the Elasticsearch mapping before we call tableau submit
                    // There is a bug when getColumnHeaders is invoked, and you call 'headersCallback'
                    // asynchronously
                    getElasticsearchTypeMapping(getTableauConnectionData(), function (err, data, connectionData) {

                        if (err) {
                            abort(err);
                            return;
                        }

                        var indexName = connectionData.elasticsearchIndex;

                        // Then we selected an alias... choose the last index with a matching type name
                        // TODO: Let user choose which type from which index
                        if (data[connectionData.elasticsearchIndex] == null) {
                            _.forIn(data, function (index, indexKey) {
                                if (index.mappings[connectionData.elasticsearchType]) {
                                    indexName = indexKey;
                                }
                            });
                        }

                        if(data[indexName] == null){
                            return abort("No mapping found for type: " + connectionData.elasticsearchType + " in index: " + indexName);
                        }

                        if(data[indexName].mappings == null){
                            return abort("No mapping found for index: " + indexName);
                        }

                        if(data[indexName].mappings[connectionData.elasticsearchType] == null){
                            return abort("No mapping properties found for type: " + connectionData.elasticsearchType + " in index: " + indexName);
                        }

                        _.forIn(data[indexName].mappings[connectionData.elasticsearchType].properties, function (val, key) {
                            // TODO: Need to support nested objects and arrays in some way
                            addElasticsearchField(key, val.type, val.format, val.lat_lon)
                        });

                        console.log('[submit] Number of header columns: ' + elasticsearchFields.length);

                        var connectionName = connectionData.connectionName;
                        tableau.connectionName = connectionName ? connectionName : "Elasticsearch Datasource";

                        updateTableauConnectionData();

                        startTime = moment();
                        $('#myPleaseWait').modal('show');
                        if (tableau.phase == tableau.phaseEnum.interactivePhase || tableau.phase == tableau.phaseEnum.authPhase) {
                            console.log('[submit] Submitting tableau interactive phase data');
                            tableau.submit();
                        }
                        else {
                            abortWithError('Invalid phase: ' + tableau.phase + ' aborting', true);
                        }

                    });
                    break;

                case "aggregation":
                    var aggsQuery;
                    try {
                        aggsQuery = JSON.parse(connectionData.elasticsearchAggQuery);
                    }
                    catch (err) {
                        return abort("Error parsing aggregation query, error: " + err);
                    }

                    // var aggregations = aggsQuery.aggregations ? aggsQuery.aggregations : aggsQuery.aggs;
                    // if (!aggregations) {
                    //     return abort("Aggregation query must include 'aggregations' or 'aggs' property");
                    // }

                    // var bucketAggs = parseAggregations(aggregations, "buckets");
                    //
                    // var metricAggs = parseAggregations(aggregations, "metrics");
                    // TODO: Add validation that checks if we found metrics at any other level besides the deepest

                    // _.each(bucketAggs, function (bucketAgg) {
                    //     addElasticsearchField(bucketAgg.name, bucketAgg.type, bucketAgg.format, null)
                    // });
                    // _.each(metricAggs, function (metricAgg) {
                    //     addElasticsearchField(metricAgg.name, metricAgg.type, metricAgg.format, null)
                    // });

                    // console.log('[submit] Number of header columns: ' + elasticsearchFields.length);

                    var connectionName = connectionData.connectionName;
                    tableau.connectionName = connectionName ? connectionName : "Elasticsearch Datasource";


                    //////
                    var headerNames = $('#inputHeaderNames').val();
                    var headerTypes = $('#inputHeaderTypes').val();


                    var names = headerNames.split(',');
                    var types = headerNames.split(',');

                    _.each(names, function(name, index){
                      elasticsearchFields.push({ name: name, dataType: types[index] });
                    });

                    updateTableauConnectionData();
                    //////


                    startTime = moment();
                    $('#myPleaseWait').modal('show');
                    if (tableau.phase == tableau.phaseEnum.interactivePhase || tableau.phase == tableau.phaseEnum.authPhase) {
                        console.log('[submit] Submitting tableau interactive phase data');
                        tableau.submit();
                    }
                    else {
                        abortWithError('Invalid phase: ' + tableau.phase + ' aborting', true);
                    }

                    break;
            }

        });

        $("#inputElasticsearchIndexTypeahead").typeahead({
            source: function (something, cb) {

                $('.index-icon').toggleClass('hide');

                getElasticsearchIndices(function (err, indices) {

                    if (err) {
                        $('.index-icon').toggleClass('hide');
                        return abort(err);
                    }

                    getElasticsearchAliases(function (err, aliases) {

                        $('.index-icon').toggleClass('hide');

                        if (err) {
                            return abort(err);
                        }
                        var sourceData = indices.concat(_.uniq(aliases));

                        // Return the actual list of items to the control
                        cb(sourceData);
                    });

                });
            },
            autoSelect: true,
            showHintOnFocus: true,
            items: 'all'
        });

        $("#inputElasticsearchTypeTypeahead").typeahead({
            source: function (something, cb) {

                $('.type-icon').toggleClass('hide');

                var connectionData = getTableauConnectionData();
                getElasticsearchTypes(connectionData.elasticsearchIndex, function (err, types) {
                    $('.type-icon').toggleClass('hide');

                    if (err) {
                        return abort(err);
                    }

                    // Return the actual list of items to the control
                    cb(types);
                });
            },
            autoSelect: true,
            showHintOnFocus: true,
            items: 'all'
        });

    };

    var getElasticsearchTypes = function (indexName, cb) {

        var connectionData = getTableauConnectionData();

        if (!connectionData.elasticsearchUrl || !connectionData.elasticsearchIndex) {
            return;
        }

        var connectionUrl = connectionData.elasticsearchUrl + '/' + indexName + '/_mapping';

        var xhr = $.ajax({
            url: connectionUrl,
            method: 'GET',
            contentType: 'application/json',
            dataType: 'json',
            beforeSend: function (xhr) {
                if (connectionData.elasticsearchAuthenticate && tableau.username) {
                    xhr.setRequestHeader("Authorization", "Basic " +
                        btoa(tableau.username + ":" + tableau.password));
                }

            },
            success: function (data) {

                clearError();

                var indices = _.keys(data);
                var typeMap = {};

                var esTypes = [];

                _.each(indices, function (index) {
                    var types = _.keys(data[index].mappings);

                    esTypes = esTypes.concat(types);
                });

                cb(null, esTypes);
            },
            error: function (xhr, ajaxOptions, err) {
                if (xhr.status == 0) {
                    cb('Unable to get Elasticsearch types, unable to connect to host or CORS request was denied');
                }
                else {
                    cb("Unable to get Elasticsearch types, status code:  " + xhr.status + '; ' + xhr.responseText + "\n" + err);
                }
            }
        });
    }

    var getElasticsearchIndices = function (cb) {

        var connectionData = getTableauConnectionData();

        if (!connectionData.elasticsearchUrl) {
            return;
        }

        var connectionUrl = connectionData.elasticsearchUrl + '/_mapping';

        var xhr = $.ajax({
            url: connectionUrl,
            method: 'GET',
            contentType: 'application/json',
            dataType: 'json',
            beforeSend: function (xhr) {
                if (connectionData.elasticsearchAuthenticate && tableau.username) {
                    xhr.setRequestHeader("Authorization", "Basic " +
                        btoa(tableau.username + ":" + tableau.password));
                }

            },
            success: function (data) {

                clearError();

                var indices = _.keys(data);

                cb(null, indices);
            },
            error: function (xhr, ajaxOptions, err) {
                if (xhr.status == 0) {
                    cb('Unable to get Elasticsearch indices, unable to connect to host or CORS request was denied');
                }
                else {
                    cb("Unable to get Elasticsearch indices, status code:  " + xhr.status + '; ' + xhr.responseText + "\n" + err);
                }
            }
        });
    }

    var getElasticsearchAliases = function (cb) {

        var connectionData = getTableauConnectionData();

        if (!connectionData.elasticsearchUrl) {
            return;
        }

        var connectionUrl = connectionData.elasticsearchUrl + '/_aliases';

        var xhr = $.ajax({
            url: connectionUrl,
            method: 'GET',
            contentType: 'application/json',
            dataType: 'json',
            beforeSend: function (xhr) {
                if (connectionData.elasticsearchAuthenticate && tableau.username) {
                    xhr.setRequestHeader("Authorization", "Basic " +
                        btoa(tableau.username + ":" + tableau.password));
                }

            },
            success: function (data) {

                clearError();

                var aliasMap = {},
                    aliases = [];

                _.forIn(data, function (value, key) {
                    aliases = aliases.concat(_.keys(value.aliases));
                });

                cb(null, aliases);
            },
            error: function (xhr, ajaxOptions, err) {
                if (xhr.status == 0) {
                    cb('Unable to get Elasticsearch aliases, unable to connect to host or CORS request was denied');
                }
                else {
                    cb("Unable to get Elasticsearch aliases, status code:  " + xhr.status + '; ' + xhr.responseText + "\n" + err);
                }
            }
        });
    };

    var openSearchScrollWindow = function (cb) {

        var connectionData = JSON.parse(tableau.connectionData);

        if (!connectionData.elasticsearchUrl) {
            return;
        }

        var requestData = {};

        var strippedQuery = $.trim(connectionData.elasticsearchQuery);
        if (strippedQuery) {
            try {
                requestData = JSON.parse(connectionData.elasticsearchQuery);
            }
            catch (err) {
                abort("Error parsing custom query: " + connectionData.elasticsearchQuery + "\nError:" + err);
                return;
            }
        }
        else {
            requestData = {
                query: { match_all: {} }
            };
        }

        requestData.size = connectionData.batchSize;

        var connectionUrl = connectionData.elasticsearchUrl + '/' + connectionData.elasticsearchIndex + '/' +
            connectionData.elasticsearchType + '/_search?scroll=5m';

        var xhr = $.ajax({
            url: connectionUrl,
            method: 'POST',
            processData: false,
            data: JSON.stringify(requestData),
            dataType: 'json',
            beforeSend: function (xhr) {
                if (connectionData.elasticsearchAuthenticate && tableau.username) {
                    xhr.setRequestHeader("Authorization", "Basic " +
                        btoa(tableau.username + ":" + tableau.password));
                }

            },
            success: function (data) {

                clearError();

                var result = processSearchResults(data);

                cb(null, result.scrollId);
            },
            error: function (xhr, ajaxOptions, err) {
                if (xhr.status == 0) {
                    cb('Error creating Elasticsearch scroll window, unable to connect to host or CORS request was denied', true);
                }
                else {
                    cb("Error creating Elasticsearch scroll window, status code:  " + xhr.status + '; ' + xhr.responseText + "\n" + err, true);
                }
            }
        });
    };

    var getNextScrollResult = function (scrollId, cb) {
        var connectionData = JSON.parse(tableau.connectionData);

        if (!connectionData.elasticsearchUrl) {
            return;
        }

        var connectionUrl = connectionData.elasticsearchUrl + '/_search/scroll';

        var requestData = {
            scroll: '5m',
            scroll_id: scrollId
        };

        var xhr = $.ajax({
            url: connectionUrl,
            method: 'POST',
            processData: false,
            data: JSON.stringify(requestData),
            dataType: 'json',
            beforeSend: function (xhr) {
                if (connectionData.elasticsearchAuthenticate && tableau.username) {
                    xhr.setRequestHeader("Authorization", "Basic " +
                        btoa(tableau.username + ":" + tableau.password));
                }

            },
            success: function (data) {
                clearError();

                var result = processSearchResults(data);

                if (cb) {
                    cb(null, result.results);
                }
            },
            error: function (xhr, ajaxOptions, err) {
                if (xhr.status == 0) {
                    cb('Error processing next scroll result, unable to connect to host or CORS request was denied', true);
                }
                else {
                    cb("Error processing next scroll result, status code:  " + xhr.status + '; ' + xhr.responseText + "\n" + err, true);
                }
            }
        });
    };

    var processSearchResults = function (data) {

        var connectionData = JSON.parse(tableau.connectionData);
        searchHitsTotal = data.hits.total;

        console.log('[processSearchResults] total search hits: ' + searchHitsTotal);

        if (data.hits.hits) {
            var hits = data.hits.hits;
            var ii;
            var toRet = [];

            var hitsToProcess = hits.length;
            if (connectionData.limit && (totalCount + hits.length > connectionData.limit)) {
                hitsToProcess = connectionData.limit - totalCount;
            }

            // mash the data into an array of objects
            for (ii = 0; ii < hitsToProcess; ++ii) {

                var item = {};

                // Add blank fields to match the specified columns (otherwise Tableau complains
                // about this noisily in its log files
                _.each(connectionData.fields, function (field) {

                    item[field.name] = _.isNull(hits[ii]._source[field.name]) || _.isUndefined(hits[ii]._source[field.name]) ?
                        null :
                        hits[ii]._source[field.name];
                });

                // Copy over any formatted value to the source object
                _.each(connectionData.dateFields, function (field) {

                    if (!item[field]) {
                        return;
                    }

                    item[field] = moment.utc(item[field].replace(' +', '+')
                        .replace(' -', '-')).format('YYYY-MM-DD HH:mm:ss');
                });
                _.each(connectionData.geoPointFields, function (field) {

                    if (!item[field.name]) {
                        return;
                    }

                    var latLonParts = item[field.name] ? item[field.name].split(', ') : [];
                    if (latLonParts.length != 2) {
                        console.log('[getTableData] Bad format returned for geo_point field: ' + field.name + '; value: ' + item[field.name]);
                        return;
                    }
                    item[field.name + '_latitude'] = parseFloat(latLonParts[0]);
                    item[field.name + '_longitude'] = parseFloat(latLonParts[1]);
                });
                item._id = hits[ii]._id;
                item._sequence = totalCount + ii;

                toRet.push(item);
            }

            totalCount += hitsToProcess;
            // If we have a limit, retrieve up to that limit, otherwise
            // wait until we have no more results returned

            var moreRecords = connectionData.limit ? totalCount < connectionData.limit : data.hits.hits.length > 0;
            console.log('[processSearchResults] total processed ' + totalCount + ', limit: ' +
                connectionData.limit + ' more records?: ' + moreRecords);

            tableau.dataCallback(toRet, data._scroll_id, moreRecords);

            return { results: toRet, scrollId: data._scroll_id };

        } else {
            console.log("[getNextScrollResult] No results found for Elasticsearch query: " + JSON.stringify(requestData));
            tableau.dataCallback([]);

            return ([]);
        }
    };

    var getAggregationResponse = function (lastRecordToken) {

        var connectionData = JSON.parse(tableau.connectionData);

        if (!connectionData.elasticsearchUrl) {
            return;
        }

        var requestData = {};

        var strippedQuery = $.trim(connectionData.elasticsearchAggQuery);
        if (strippedQuery) {
            try {
                requestData = JSON.parse(connectionData.elasticsearchAggQuery);
            }
            catch (err) {
                abort("Error parsing custom aggregation query: " + connectionData.elasticsearchAggQuery + "\nError:" + err);
                return;
            }
        }
        else {
            abort("No custom aggregation query provided", true);
            return;
        }

        // Dont return search results
        requestData.size = 0;

        var connectionUrl = connectionData.elasticsearchUrl + '/' + connectionData.elasticsearchIndex + '/' +
            connectionData.elasticsearchType + '/_search';

        var xhr = $.ajax({
            url: connectionUrl,
            method: 'POST',
            processData: false,
            data: JSON.stringify(requestData),
            dataType: 'json',
            beforeSend: function (xhr) {
                if (connectionData.elasticsearchAuthenticate && tableau.username) {
                    xhr.setRequestHeader("Authorization", "Basic " +
                        btoa(tableau.username + ":" + tableau.password));
                }

            },
            success: function (data) {

                clearError();
                // var result = processAggregationData(data);

                var func = new Function('data', connectionData.parserFunction);
                var result = func(data);

                tableau.dataCallback(result, lastRecordToken, false);

            },
            error: function (xhr, ajaxOptions, err) {
                if (xhr.status == 0) {
                    console.log('Error creating Elasticsearch scroll window, unable to connect to host or CORS request was denied');
                }
                else {
                    console.log("Error creating Elasticsearch scroll window, status code:  " + xhr.status + '; ' + xhr.responseText + "\n" + err);
                }
            }
        });
    };

    var processAggregationData = function (data) {

        var aggregations = data.aggregations;
        if (!aggregations) {
            abort("No 'aggregations' property in response", true);
        }

        var rows = [];
        var currentRow = {};

        visitAggregationResponseLevels(aggregations, rows, currentRow);

        return rows;
    };

    var visitAggregationResponseLevels = function (agg, rows, currentRow) {

        var connectionData = JSON.parse(tableau.connectionData),
            elasticsearchAggsMap = connectionData.aggFieldsMap;

        var keys = _.keys(agg),
            moreBucketsToVisit = false;
        _.each(keys, function (key) {

            var field = elasticsearchAggsMap[key];
            if(!field){
                return;
            }

            if (field.indexOf("bucket_") == 0) {
                moreBucketsToVisit = true;

                // Depth-first search into each bucket...
                _.each(agg[key].buckets, function (bucket) {

                    var bucketValue;
                    if (field.indexOf("bucket_date_histogram_") == 0) {
                        bucketValue = moment.utc(bucket.key_as_string).format('YYYY-MM-DD HH:mm:ss');
                    }
                    else {
                        bucketValue = bucket.key;
                    }
                    console.log(field + " = " + bucketValue)
                    currentRow[field] = bucketValue;

                    // Set the count field associated with this bucket (at the deepest level)
                    // TODO: Only set this when we are on a bucket agg at the deepest level
                    currentRow["metric_count_" + key] = bucket.doc_count;
                    console.log("metric_count_" + key + " = " + bucket.doc_count);

                    visitAggregationResponseLevels(bucket, rows, currentRow);
                });
            }

            if (field.indexOf("metric_") == 0) {
                if (field.indexOf("metric_sum_") == 0 ||
                    field.indexOf("metric_avg_") == 0 ||
                    field.indexOf("metric_min_") == 0 ||
                    field.indexOf("metric_max_") == 0 ||
                    field.indexOf("metric_count_") == 0) {

                    console.log(field + " = " + agg[key].value)
                    currentRow[field] = agg[key].value;
                }
                if (field.indexOf("metric_stats_") == 0) {
                    var fieldName = field.substring("metric_stats_".length)
                    console.log(field + " = " + JSON.stringify(agg[key]));

                    currentRow["metric_sum_" + fieldName] = agg[key].sum;
                    currentRow["metric_avg_" + fieldName] = agg[key].avg;
                    currentRow["metric_min_" + fieldName] = agg[key].min;
                    currentRow["metric_max_" + fieldName] = agg[key].max;
                    currentRow["metric_count_" + fieldName] = agg[key].count;
                }
                if (field.indexOf("metric_extended_stats_") == 0) {
                    var fieldName = field.substring("metric_extended_stats_".length);
                    console.log(field + " = " + JSON.stringify(agg[key]));

                    currentRow["metric_sum_" + fieldName] = agg[key].sum;
                    currentRow["metric_avg_" + fieldName] = agg[key].avg;
                    currentRow["metric_min_" + fieldName] = agg[key].min;
                    currentRow["metric_max_" + fieldName] = agg[key].max;
                    currentRow["metric_count_" + fieldName] = agg[key].count;
                    currentRow["metric_sum_of_squares_" + fieldName] = agg[key].sum_of_squares;
                    currentRow["metric_variance_" + fieldName] = agg[key].variance;
                    currentRow["metric_std_deviation_" + fieldName] = agg[key].std_deviation;
                    currentRow["metric_std_deviation_bounds_lower_" + fieldName] = agg[key].std_deviation_bounds.lower;
                    currentRow["metric_std_deviation_bounds_upper_" + fieldName] = agg[key].std_deviation_bounds.upper;
                }
            }


        });

        if (!moreBucketsToVisit) {

            var row = _.cloneDeep(currentRow);
            rows.push(row);

            currentRow = {};

            console.log("Did not find a child property that matches an aggregation name - depth reached");
            return;
        }

    };

    var parseAggregations = function (aggregations, mode) {

        var fields = [];

        firstLevelAggs = _.keys(aggregations);
        if (firstLevelAggs.length > 1) {
            abort("Should only supply a single bucket aggregation at each level, found the following aggregations: " + firstLevelAggs.join(", "));
            return null;
        }

        currentAggLevel = aggregations;
        while (currentAggLevel != null) {

            visitAggLevel(fields, currentAggLevel, mode);

            // Drill into any child aggregations
            var keys = _.keys(currentAggLevel),
                foundMoreLevels = false;
            _.each(keys, function (key) {
                var aggInfo = currentAggLevel[key];

                if (aggInfo.aggregations || aggInfo.aggs) {
                    foundMoreLevels = true;
                    currentAggLevel = aggInfo.aggs ? aggInfo.aggs : aggInfo.aggregations;
                }
                else{
                    // If we are at the deepest level and we are collecting metrics - add a count
                    if (hasSupportedBucketAggregation(aggInfo) && mode == "metrics") {
                        fields.push({
                            name: "metric_count_" + key,
                            type: "integer"
                        });
                    }
                }
            });

            if(!foundMoreLevels){
                currentAggLevel = null;
            }
        }

        return fields;
    };

    var hasSupportedBucketAggregation = function (agg) {
        if (agg.date_histogram || agg.terms || agg.range || agg.date_range) {
            return true;
        }
        else {
            return false;
        }
    }

    var visitAggLevel = function (accumulatedFields, agg, mode) {

        var keys = _.keys(agg);

        _.each(keys, function (key) {

            var aggInfo = agg[key];

            if (mode == "buckets") {

                var field, name, type, format;

                // Only look at the first bucket
                if (aggInfo.date_histogram) {
                    field = aggInfo.date_histogram.field,
                    name = "bucket_date_histogram_" + field,
                    type = "date";
                }
                if (aggInfo.terms) {
                    field = aggInfo.terms.field;
                    name = "bucket_terms_" + field;
                    type = "string";
                }
                if (aggInfo.range) {

                    field = aggInfo.range.field;
                    name = "bucket_range_" + field;
                    type = "string";
                }
                if (aggInfo.date_range) {

                    field = aggInfo.date_range.field;
                    name = "bucket_date_range_" + field;
                    type = "string";
                }

                if (hasSupportedBucketAggregation(aggInfo)) {
                    accumulatedFields.push({
                        name: name,
                        type: type,
                        format: format
                    });
                    elasticsearchAggsMap[key] = name;
                }

                // TODO: Check to see if we have duplicate aggregation key names... would be a problem
            }
            if (mode == "metrics") {

                if (aggInfo.avg) {
                    field = aggInfo.avg.field;

                    accumulatedFields.push({
                        name: "metric_avg_" + field,
                        type: "float"
                    });
                    elasticsearchAggsMap[key] = "metric_avg_" + field;
                }
                if (aggInfo.sum) {
                    field = aggInfo.sum.field;

                    accumulatedFields.push({
                        name: "metric_sum_" + field,
                        type: "float"
                    });
                    elasticsearchAggsMap[key] = "metric_sum_" + field;
                }
                if (aggInfo.min) {
                    field = aggInfo.min.field;

                    accumulatedFields.push({
                        name: "metric_min_" + field,
                        type: "float"
                    });
                    elasticsearchAggsMap[key] = "metric_min_" + field;
                }
                if (aggInfo.max) {
                    field = aggInfo.max.field;

                    accumulatedFields.push({
                        name: "metric_max_" + field,
                        type: "float"
                    });
                    elasticsearchAggsMap[key] = "metric_max_" + field;
                }
                if (aggInfo.stats) {
                    field = aggInfo.stats.field;

                    accumulatedFields.push({
                        name: "metric_sum_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_min_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_max_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_avg_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_count_" + field,
                        type: "float"
                    });
                    elasticsearchAggsMap[key] = "metric_stats_" + field;
                }
                if (aggInfo.extended_stats) {
                    field = aggInfo.extended_stats.field;

                    accumulatedFields.push({
                        name: "metric_sum_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_min_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_max_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_avg_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_count_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_sum_of_squares_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_variance_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_std_deviation_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_std_deviation_bounds_lower_" + field,
                        type: "float"
                    });
                    accumulatedFields.push({
                        name: "metric_std_deviation_bounds_upper_" + field,
                        type: "float"
                    });
                    elasticsearchAggsMap[key] = "metric_extended_stats_" + field;
                }
            }

        });

    }

    var getTableauConnectionData = function () {

        var max_iterations = parseInt($('#inputBatchSize').val()) == NaN ? 10 : parseInt($('#inputBatchSize').val());
        var limit = parseInt($('#inputTotalLimit').val()) == NaN ? null : parseInt($('#inputTotalLimit').val());
        var connectionName = $('#inputConnectionName').val();
        var auth = $('#cbUseBasicAuth').is(':checked');
        var username = $('#inputUsername').val();
        var password = $('#inputPassword').val();
        var esUrl = $('#inputElasticsearchUrl').val();
        var esIndex = $('#inputElasticsearchIndexTypeahead').val();
        var esType = $('#inputElasticsearchTypeTypeahead').val();

        var esQuery = queryEditor.getValue();

        var resultMode = $("input:radio[name='resultmode']:checked").val();
        var esAggQuery = aggQueryEditor.getValue();
        var parserFunction = parserEditor.getValue();

        var connectionData = {
            connectionName: connectionName,
            elasticsearchUrl: esUrl,
            elasticsearchAuthenticate: auth,
            elasticsearchUsername: username,
            elasticsearchPassword: password,
            elasticsearchIndex: esIndex,
            elasticsearchType: esType,
            elasticsearchQuery: esQuery,
            elasticsearchResultMode: resultMode,
            elasticsearchAggQuery: esAggQuery,
            fields: elasticsearchFields,
            fieldsMap: elasticsearchFieldsMap,
            aggFieldsMap: elasticsearchAggsMap,
            dateFields: elasticsearchDateFields,
            geoPointFields: elasticsearchGeoPointFields,
            batchSize: max_iterations,
            parserFunction: parserFunction,
            limit: limit
        };

        // Update Tableau auth parameters if supplied
        if (connectionData.elasticsearchAuthenticate) {
            tableau.username = connectionData.elasticsearchUsername;
            tableau.password = connectionData.elasticsearchPassword;
        }

        return connectionData;
    };

    var updateTableauConnectionData = function (updatedMap) {

        var connectionData = getTableauConnectionData();

        if (updatedMap) {
            _.forIn(updateMap, function (val, key) {
                connectionData[key] = val;
            });
        }

        if (connectionData.elasticsearchAuthenticate) {
            tableau.username = connectionData.elasticsearchUsername;
            tableau.password = connectionData.elasticsearchPassword;
        }

        delete connectionData.elasticsearchUsername;
        delete connectionData.elasticsearchPassword;


        tableau.connectionData = JSON.stringify(connectionData);

        console.log('[updateTableauConnectionData] Connection data: ' + tableau.connectionData);
        return connectionData;
    };

})();
